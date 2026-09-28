import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { available } from '../catalog/catalog.service';
import type { AuthUser } from '../common/auth';
import { CART_COOKIE, cartCookie } from '../common/cookies';
import { randomToken } from '../common/crypto';
import {
  checkPromo,
  lineTotal,
  quote,
  type PricedLine,
  type Promo,
} from '../common/pricing';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import type { AddItemDto } from './dto';

export const MAX_PER_SKU = 10;

const cartInclude = {
  items: {
    orderBy: { id: 'asc' },
    include: {
      sku: {
        include: {
          color: {
            include: {
              images: { orderBy: { sortOrder: 'asc' }, take: 1 },
              product: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CartInclude;

export type CartRecord = Prisma.CartGetPayload<{ include: typeof cartInclude }>;
type Db = Prisma.TransactionClient | PrismaService;

export const pricedLines = (cart: CartRecord): PricedLine[] =>
  cart.items.map((i) => ({
    qty: i.qty,
    unitPrice: i.sku.salePrice ?? i.sku.price,
    voucherEligible: i.sku.color.product.voucherEligible,
  }));

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's bag, or null if they have none yet. Members use their account bag, guests the cookie. */
  current(req: Request, user?: AuthUser, db: Db = this.prisma) {
    if (user)
      return db.cart.findUnique({
        where: { userId: user.id },
        include: cartInclude,
      });
    const token = req.cookies?.[CART_COOKIE] as string | undefined;
    return token
      ? db.cart.findFirst({
          where: { token, userId: null },
          include: cartInclude,
        })
      : null;
  }

  private async ensure(req: Request, res: Response, user?: AuthUser) {
    const cart = await this.current(req, user);
    if (cart) return cart;
    const token = randomToken();
    if (!user) res.cookie(CART_COOKIE, token, cartCookie());
    return this.prisma.cart.create({
      data: { token, userId: user?.id },
      include: cartInclude,
    });
  }

  private async reload(id: string) {
    return this.view(
      await this.prisma.cart.findUniqueOrThrow({
        where: { id },
        include: cartInclude,
      }),
    );
  }

  async promoFor(
    cart: CartRecord,
  ): Promise<{ promo: Promo | null; error: string | null }> {
    if (!cart.promoCode) return { promo: null, error: null };
    const promo = await this.prisma.promotion.findUnique({
      where: { code: cart.promoCode },
    });
    const error = checkPromo(promo, pricedLines(cart));
    return error ? { promo: null, error } : { promo, error: null };
  }

  /** Bag as the storefront renders it. Stock is re-validated on every read (BAG-8). */
  async view(cart: CartRecord | null) {
    if (!cart)
      return {
        items: [],
        count: 0,
        promoCode: null,
        promoError: null,
        ...quote([]),
      };
    const { promo, error } = await this.promoFor(cart);
    const lines = pricedLines(cart);
    return {
      items: cart.items.map((i, n) => {
        const left = available(i.sku);
        const { color } = i.sku;
        return {
          id: i.id,
          skuId: i.skuId,
          slug: color.product.slug,
          name: color.product.name,
          color: color.name,
          colorHex: color.hex,
          colorTone: color.tone,
          size: i.sku.size,
          image: color.images[0]?.url,
          price: i.sku.price,
          salePrice: i.sku.salePrice ?? undefined,
          unitPrice: lines[n].unitPrice,
          qty: i.qty,
          lineTotal: lineTotal(lines[n]),
          available: left,
          maxQty: Math.min(MAX_PER_SKU, left),
          voucherEligible: color.product.voucherEligible,
          issue: left === 0 ? 'sold_out' : left < i.qty ? 'low_stock' : null,
        };
      }),
      count: cart.items.reduce((n, i) => n + i.qty, 0),
      promoCode: cart.promoCode,
      promoError: error,
      ...quote(lines, 'standard', promo),
    };
  }

  async get(req: Request, user?: AuthUser) {
    return this.view(await this.current(req, user));
  }

  async add(
    req: Request,
    res: Response,
    user: AuthUser | undefined,
    dto: AddItemDto,
  ) {
    const sku = await this.prisma.sku.findFirst({
      where: {
        size: dto.size,
        color: {
          name: dto.color,
          product: { slug: dto.slug, status: 'published' },
        },
      },
    });
    if (!sku)
      throw new NotFoundException("That colour and size isn't available.");
    const cart = await this.ensure(req, res, user);
    const existing = cart.items.find((i) => i.skuId === sku.id)?.qty ?? 0;
    this.assertQty(existing + dto.qty, sku);
    await this.prisma.cartItem.upsert({
      where: { cartId_skuId: { cartId: cart.id, skuId: sku.id } },
      create: { cartId: cart.id, skuId: sku.id, qty: dto.qty },
      update: { qty: existing + dto.qty },
    });
    return this.reload(cart.id);
  }

  async setQty(
    req: Request,
    user: AuthUser | undefined,
    itemId: string,
    qty: number,
  ) {
    const cart = await this.current(req, user);
    const item = cart?.items.find((i) => i.id === itemId);
    if (!cart || !item)
      throw new NotFoundException('That item is no longer in your bag.');
    this.assertQty(qty, item.sku);
    await this.prisma.cartItem.update({ where: { id: itemId }, data: { qty } });
    return this.reload(cart.id);
  }

  async remove(req: Request, user: AuthUser | undefined, itemId: string) {
    const cart = await this.current(req, user);
    if (!cart?.items.some((i) => i.id === itemId))
      throw new NotFoundException('That item is no longer in your bag.');
    await this.prisma.cartItem.delete({ where: { id: itemId } });
    return this.reload(cart.id);
  }

  async clear(req: Request, user?: AuthUser) {
    const cart = await this.current(req, user);
    if (cart)
      await this.prisma.cart.update({
        where: { id: cart.id },
        data: { promoCode: null, items: { deleteMany: {} } },
      });
    return this.view(null);
  }

  async applyPromo(req: Request, user: AuthUser | undefined, rawCode: string) {
    const cart = await this.current(req, user);
    if (!cart?.items.length)
      throw new UnprocessableEntityException(
        'Add something to your bag first.',
      );
    const code = rawCode.trim().toUpperCase();
    const promo = await this.prisma.promotion.findUnique({ where: { code } });
    const error = checkPromo(promo, pricedLines(cart));
    if (error) throw new UnprocessableEntityException(error);
    await this.prisma.cart.update({
      where: { id: cart.id },
      data: { promoCode: code },
    });
    return this.reload(cart.id);
  }

  async removePromo(req: Request, user?: AuthUser) {
    const cart = await this.current(req, user);
    if (!cart) return this.view(null);
    await this.prisma.cart.update({
      where: { id: cart.id },
      data: { promoCode: null },
    });
    return this.reload(cart.id);
  }

  /** Moves a guest bag into the member's bag after sign-in (BAG-7). Quantities add up, capped by stock. */
  async mergeGuest(token: string | undefined, userId: string) {
    if (!token) return;
    const guest = await this.prisma.cart.findFirst({
      where: { token, userId: null },
      include: cartInclude,
    });
    if (!guest) return;
    await this.prisma.$transaction(async (tx) => {
      const mine =
        (await tx.cart.findUnique({
          where: { userId },
          include: cartInclude,
        })) ??
        (await tx.cart.create({
          data: { token: randomToken(), userId },
          include: cartInclude,
        }));
      for (const item of guest.items) {
        const have = mine.items.find((i) => i.skuId === item.skuId)?.qty ?? 0;
        const qty = Math.min(MAX_PER_SKU, available(item.sku), have + item.qty);
        if (qty <= 0) continue;
        await tx.cartItem.upsert({
          where: { cartId_skuId: { cartId: mine.id, skuId: item.skuId } },
          create: { cartId: mine.id, skuId: item.skuId, qty },
          update: { qty },
        });
      }
      if (!mine.promoCode && guest.promoCode)
        await tx.cart.update({
          where: { id: mine.id },
          data: { promoCode: guest.promoCode },
        });
      await tx.cart.delete({ where: { id: guest.id } });
    });
  }

  private assertQty(
    qty: number,
    sku: { size: string; stock: number; reserved: number },
  ) {
    if (qty > MAX_PER_SKU)
      throw new ConflictException(
        `You can buy up to ${MAX_PER_SKU} of each item.`,
      );
    const left = available(sku);
    if (left === 0)
      throw new ConflictException(
        `${sku.size} just sold out. Choose another size or tap Notify me.`,
      );
    if (qty > left)
      throw new ConflictException(`Only ${left} left in ${sku.size}.`);
  }
}
