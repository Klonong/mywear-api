import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import { CartService, pricedLines } from '../cart/cart.service';
import type { AuthUser } from '../common/auth';
import { orderNumber } from '../common/crypto';
import { MailService } from '../common/mail.service';
import { quote } from '../common/pricing';
import { env, RESERVATION_MINUTES } from '../config';
import { Prisma } from '../generated/prisma/client';
import type { OrderStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma.service';
import type { CheckoutDto, PaymentEventDto, ReturnRequestDto } from './dto';

const orderInclude = {
  items: { orderBy: { id: 'asc' } },
  shipments: { orderBy: { createdAt: 'desc' } },
  payments: { orderBy: { createdAt: 'desc' } },
  returns: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.OrderInclude;
type OrderRecord = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
type Tx = Prisma.TransactionClient;

export const toOrder = (o: OrderRecord) => ({
  number: o.number,
  status: o.status,
  createdAt: o.createdAt,
  paidAt: o.paidAt,
  reservationExpiresAt: o.reservationExpiresAt,
  email: o.email,
  phone: o.phone,
  deliveryMethod: o.deliveryMethod,
  paymentMethod: o.paymentMethod,
  promoCode: o.promoCode,
  subtotal: o.subtotal,
  discount: o.discount,
  shipping: o.shipping,
  total: o.total,
  address: o.addressSnapshot,
  items: o.items.map((i) => ({
    id: i.id,
    slug: i.productSlug,
    name: i.nameSnapshot,
    color: i.colorSnapshot,
    size: i.sizeSnapshot,
    unitPrice: i.unitPrice,
    qty: i.qty,
    lineTotal: i.unitPrice * i.qty,
  })),
  shipments: o.shipments.map(({ courier, trackingNumber, createdAt }) => ({
    courier,
    trackingNumber,
    createdAt,
  })),
  payment: o.payments[0] && {
    provider: o.payments[0].provider,
    method: o.payments[0].method,
    status: o.payments[0].status,
    amount: o.payments[0].amount,
  },
  returns: o.returns.map(({ id, items, reason, createdAt }) => ({
    id,
    items,
    reason,
    createdAt,
  })),
});

/** Allowed manual status changes (admin). Payment moves pending_payment -> paid via the gateway only. */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['cancelled'],
  paid: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['return_requested', 'returned'],
  return_requested: ['returned', 'delivered'],
  returned: ['refunded'],
  cancelled: ['refunded'],
  refunded: [],
};

/** Orders whose goods left stock (paid and later) */
export const BOUGHT: OrderStatus[] = [
  'paid',
  'processing',
  'shipped',
  'delivered',
  'return_requested',
  'returned',
];

@Injectable()
export class OrdersService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Orders');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly mail: MailService,
  ) {}

  // Releases unpaid reservations every minute. Safe on several instances: the status check makes it idempotent.
  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.expireReservations().catch((e: Error) =>
          this.log.error(e.message),
        ),
      60_000,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async checkout(req: Request, user: AuthUser | undefined, dto: CheckoutDto) {
    const cart = await this.cart.current(req, user);
    if (!cart?.items.length)
      throw new UnprocessableEntityException('Your bag is empty.');

    let address: Prisma.InputJsonObject;
    if (dto.addressId) {
      if (!user)
        throw new UnauthorizedException('Sign in to use a saved address.');
      const saved = await this.prisma.address.findFirst({
        where: { id: dto.addressId, userId: user.id },
      });
      if (!saved) throw new NotFoundException('Address not found');
      const { recipient, phone, line1, line2, city, province, postcode } =
        saved;
      address = { recipient, phone, line1, line2, city, province, postcode };
    } else if (dto.address) {
      const a = dto.address;
      address = {
        recipient: `${a.firstName} ${a.lastName}`.trim(),
        phone: dto.phone,
        line1: a.line1,
        line2: a.line2 ?? null,
        city: a.city,
        province: a.province ?? null,
        postcode: a.postcode,
      };
    } else {
      throw new BadRequestException('Add a delivery address.');
    }

    const { promo, error } = await this.cart.promoFor(cart);
    if (error)
      throw new UnprocessableEntityException(
        `${error} Remove the code to continue.`,
      );
    const lines = pricedLines(cart);
    const totals = quote(lines, dto.deliveryMethod, promo);
    const number = orderNumber();

    const order = await this.prisma.$transaction(async (tx) => {
      // Reserve stock atomically: the WHERE is re-checked under the row lock, so the last unit sells exactly once
      for (const item of cart.items) {
        const reserved =
          await tx.$executeRaw`UPDATE "Sku" SET "reserved" = "reserved" + ${item.qty} WHERE "id" = ${item.skuId} AND "stock" - "reserved" >= ${item.qty}`;
        if (reserved !== 1) {
          throw new ConflictException(
            `${item.sku.color.product.name} in ${item.sku.size} just sold out. Update your bag to continue.`,
          );
        }
      }
      if (promo) {
        const used =
          await tx.$executeRaw`UPDATE "Promotion" SET "usedCount" = "usedCount" + 1 WHERE "code" = ${promo.code} AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
        if (used !== 1)
          throw new UnprocessableEntityException(
            'This code has been fully redeemed. Remove it to continue.',
          );
      }
      const created = await tx.order.create({
        data: {
          number,
          userId: user?.id,
          email: dto.email.toLowerCase(),
          phone: dto.phone,
          deliveryMethod: dto.deliveryMethod,
          paymentMethod: dto.paymentMethod,
          promoCode: promo?.code,
          subtotal: totals.subtotal,
          discount: totals.discount,
          shipping: totals.delivery,
          total: totals.total,
          addressSnapshot: address,
          reservationExpiresAt: new Date(
            Date.now() + RESERVATION_MINUTES * 60_000,
          ),
          items: {
            create: cart.items.map((i, n) => ({
              skuId: i.skuId,
              productSlug: i.sku.color.product.slug,
              nameSnapshot: i.sku.color.product.name,
              colorSnapshot: i.sku.color.name,
              sizeSnapshot: i.sku.size,
              unitPrice: lines[n].unitPrice,
              qty: i.qty,
            })),
          },
          // ponytail: mock gateway; plug Midtrans/Xendit/Stripe here and return their hosted payment URL (CHK-5)
          payments: {
            create: {
              provider: 'mock',
              method: dto.paymentMethod,
              amount: totals.total,
            },
          },
        },
        include: orderInclude,
      });
      await tx.cart.update({
        where: { id: cart.id },
        data: { promoCode: null, items: { deleteMany: {} } },
      });
      if (user && dto.saveAddress && dto.address) {
        const hasDefault = await tx.address.count({
          where: { userId: user.id, isDefault: true },
        });
        await tx.address.create({
          data: {
            userId: user.id,
            ...(address as {
              recipient: string;
              phone: string;
              line1: string;
              city: string;
              postcode: string;
            }),
            isDefault: !hasDefault,
          },
        });
      }
      return created;
    });

    await this.mail.send(
      order.email,
      `Order ${order.number} received`,
      `We're holding your items for ${RESERVATION_MINUTES} minutes while you pay. Total IDR ${order.total.toLocaleString('en-US')}.`,
    );
    return {
      order: toOrder(order),
      payment: {
        provider: 'mock',
        status: 'pending',
        amount: order.total,
        expiresAt: order.reservationExpiresAt,
        ...(!env.production && {
          confirmUrl: `/api/payments/mock/${order.number}/confirm`,
        }),
      },
    };
  }

  /** Gateway result for an order. Idempotent: replays of the same event are no-ops. */
  async handlePayment(event: PaymentEventDto) {
    const order = await this.prisma.order.findUnique({
      where: { number: event.orderNumber },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (event.status === 'failed') {
      await this.release(order.id, 'Payment failed', 'failed');
      return { status: 'cancelled' };
    }
    if (event.amount !== order.total)
      throw new UnprocessableEntityException(
        'Paid amount does not match the order total.',
      );

    const paid = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: order.id, status: 'pending_payment' },
        data: {
          status: 'paid',
          paidAt: new Date(),
          reservationExpiresAt: null,
        },
      });
      if (!count) return false;
      for (const item of order.items) {
        await tx.sku.update({
          where: { id: item.skuId },
          data: {
            stock: { decrement: item.qty },
            reserved: { decrement: item.qty },
          },
        });
      }
      await tx.payment.updateMany({
        where: { orderId: order.id, status: 'pending' },
        data: { status: 'paid', providerRef: event.providerRef },
      });
      return true;
    });

    if (paid) {
      await this.mail.send(
        order.email,
        `Thanks, order ${order.number} is confirmed`,
        `We'll let you know when it ships. Track it any time with your order number.`,
      );
      return { status: 'paid' };
    }
    if (order.status === 'cancelled') {
      // Money arrived after the hold expired; stock may be gone, so flag it for a refund instead of shipping
      await this.prisma.$transaction([
        this.prisma.payment.updateMany({
          where: { orderId: order.id },
          data: { status: 'paid', providerRef: event.providerRef },
        }),
        this.prisma.orderNote.create({
          data: {
            orderId: order.id,
            author: 'system',
            body: 'Payment received after the reservation expired. Refund required.',
          },
        }),
      ]);
      this.log.warn(
        `Late payment on cancelled order ${order.number}; refund required`,
      );
    }
    return { status: order.status };
  }

  /** Cancels an unpaid order and gives its reserved stock (and promo use) back. No-op if already settled. */
  async release(
    orderId: string,
    reason: string,
    paymentStatus: 'failed' | 'pending' = 'failed',
  ) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: 'pending_payment' },
        data: { status: 'cancelled', reservationExpiresAt: null },
      });
      if (!count) return false;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });
      await this.unreserve(tx, order.items);
      if (order.promoCode)
        await tx.$executeRaw`UPDATE "Promotion" SET "usedCount" = GREATEST("usedCount" - 1, 0) WHERE "code" = ${order.promoCode}`;
      await tx.payment.updateMany({
        where: { orderId, status: 'pending' },
        data: { status: paymentStatus },
      });
      await tx.orderNote.create({
        data: { orderId, author: 'system', body: reason },
      });
      return true;
    });
  }

  async expireReservations() {
    const due = await this.prisma.order.findMany({
      where: {
        status: 'pending_payment',
        reservationExpiresAt: { lt: new Date() },
      },
      select: { id: true, number: true },
      take: 200,
    });
    for (const o of due)
      if (await this.release(o.id, 'Reservation expired before payment'))
        this.log.log(`Released stock for ${o.number}`);
    return due.length;
  }

  // Reads

  async mine(userId: string) {
    const orders = await this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
    return orders.map((o) => ({
      number: o.number,
      status: o.status,
      createdAt: o.createdAt,
      total: o.total,
      itemCount: o.items.reduce((n, i) => n + i.qty, 0),
      items: o.items.slice(0, 3).map((i) => ({
        slug: i.productSlug,
        name: i.nameSnapshot,
        color: i.colorSnapshot,
        size: i.sizeSnapshot,
      })),
    }));
  }

  async byNumber(number: string, where: Prisma.OrderWhereInput = {}) {
    const order = await this.prisma.order.findFirst({
      where: { number, ...where },
      include: orderInclude,
    });
    if (!order)
      throw new NotFoundException("We can't find an order with those details.");
    return order;
  }

  /** Guest order tracking by number + email (ACC-8). Same error for wrong number or email. */
  async lookup(number: string, email: string) {
    return toOrder(
      await this.byNumber(number.trim().toUpperCase(), {
        email: email.trim().toLowerCase(),
      }),
    );
  }

  /** Return request from order detail (ACC-6). */
  async requestReturn(userId: string, number: string, dto: ReturnRequestDto) {
    const order = await this.byNumber(number, { userId });
    if (order.status !== 'delivered')
      throw new UnprocessableEntityException(
        'Returns open once your order is delivered.',
      );
    for (const r of dto.items) {
      const item = order.items.find((i) => i.id === r.orderItemId);
      if (!item || r.qty > item.qty)
        throw new BadRequestException(
          'Choose items and quantities from this order.',
        );
    }
    await this.prisma.$transaction([
      this.prisma.returnRequest.create({
        data: {
          orderId: order.id,
          items: dto.items.map(({ orderItemId, qty }) => ({
            orderItemId,
            qty,
          })),
          reason: dto.reason,
        },
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'return_requested' },
      }),
    ]);
    await this.mail.send(
      order.email,
      `Return started for ${order.number}`,
      'Drop the items at any MyWear store or book a courier pickup within 14 days. Pack them in the original bag if you can.',
    );
    return toOrder(await this.byNumber(number));
  }

  // Admin

  async setStatus(number: string, status: OrderStatus, actor: string) {
    const order = await this.byNumber(number);
    if (!TRANSITIONS[order.status].includes(status)) {
      throw new UnprocessableEntityException(
        `Can't move an order from ${order.status} to ${status}.`,
      );
    }
    if (
      status === 'refunded' &&
      !order.payments.some((p) => p.status === 'paid')
    ) {
      throw new UnprocessableEntityException(
        'This order has no captured payment to refund.',
      );
    }
    if (status === 'cancelled' && order.status === 'pending_payment') {
      await this.release(order.id, `Cancelled by ${actor}`, 'failed');
    } else {
      await this.prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status } });
        // Goods come back to stock when a paid order is cancelled or a return is received
        if (
          (status === 'cancelled' && BOUGHT.includes(order.status)) ||
          status === 'returned'
        ) {
          for (const i of order.items)
            await tx.sku.update({
              where: { id: i.skuId },
              data: { stock: { increment: i.qty } },
            });
        }
        if (status === 'refunded') {
          // ponytail: mock refund; call the gateway's refund API here
          await tx.payment.updateMany({
            where: { orderId: order.id, status: 'paid' },
            data: { status: 'refunded' },
          });
        }
        await tx.orderNote.create({
          data: {
            orderId: order.id,
            author: actor,
            body: `Status ${order.status} -> ${status}`,
          },
        });
      });
    }
    if (status === 'refunded')
      await this.mail.send(
        order.email,
        `Refund for ${order.number}`,
        `We've refunded IDR ${order.total.toLocaleString('en-US')}.`,
      );
    if (status === 'delivered')
      await this.mail.send(
        order.email,
        `Order ${order.number} delivered`,
        'Enjoy! You can review your items from your account.',
      );
    return toOrder(await this.byNumber(number));
  }

  async ship(
    number: string,
    courier: string,
    trackingNumber: string,
    actor: string,
  ) {
    const order = await this.byNumber(number);
    if (!['paid', 'processing', 'shipped'].includes(order.status))
      throw new UnprocessableEntityException(
        `Can't ship an order that is ${order.status}.`,
      );
    await this.prisma.$transaction([
      this.prisma.shipment.create({
        data: { orderId: order.id, courier, trackingNumber },
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'shipped' },
      }),
      this.prisma.orderNote.create({
        data: {
          orderId: order.id,
          author: actor,
          body: `Shipped with ${courier} (${trackingNumber})`,
        },
      }),
    ]);
    await this.mail.send(
      order.email,
      `Order ${order.number} is on its way`,
      `${courier} tracking number: ${trackingNumber}`,
    );
    return toOrder(await this.byNumber(number));
  }

  private async unreserve(tx: Tx, items: { skuId: string; qty: number }[]) {
    for (const i of items)
      await tx.$executeRaw`UPDATE "Sku" SET "reserved" = GREATEST("reserved" - ${i.qty}, 0) WHERE "id" = ${i.skuId}`;
  }
}
