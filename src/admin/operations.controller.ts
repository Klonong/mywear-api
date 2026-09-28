import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, type AuthUser } from '../common/auth';
import { OrderStatus } from '../generated/prisma/enums';
import { NoteDto, SetStatusDto, ShipmentDto } from '../orders/dto';
import { BOUGHT, OrdersService, toOrder } from '../orders/orders.service';
import { PrismaService } from '../prisma.service';
import {
  AdminOrderQueryDto,
  ModerateReviewDto,
  ReviewQueryDto,
  RoleDto,
  StatsQueryDto,
  UserQueryDto,
} from './dto';

const PAGE = 50;
const DAY = 24 * 60 * 60 * 1000;

/** Orders, reviews, customers and the sales dashboard (ADM-5, 8, 9; ADM-1 roles). */
@ApiTags('admin: operations')
@ApiBearerAuth()
@Controller('admin')
export class AdminOperationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  @Auth('support')
  @Get('orders')
  async list(@Query() query: AdminOrderQueryDto) {
    const status = Object.values(OrderStatus).find((s) => s === query.status);
    const where = {
      ...(status && { status }),
      ...(query.q && {
        OR: [
          { number: { contains: query.q, mode: 'insensitive' as const } },
          { email: { contains: query.q, mode: 'insensitive' as const } },
        ],
      }),
    };
    const page = query.page ?? 1;
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: { items: true },
      }),
      this.prisma.order.count({ where }),
    ]);
    return {
      items: rows.map((o) => ({
        number: o.number,
        status: o.status,
        email: o.email,
        total: o.total,
        itemCount: o.items.reduce((n, i) => n + i.qty, 0),
        createdAt: o.createdAt,
        paidAt: o.paidAt,
      })),
      total,
      page,
    };
  }

  @Auth('support')
  @Get('orders/:number')
  async one(@Param('number') number: string) {
    const order = await this.orders.byNumber(number);
    const notes = await this.prisma.orderNote.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...toOrder(order),
      userId: order.userId,
      payments: order.payments,
      notes,
    };
  }

  @Auth('support')
  @Patch('orders/:number/status')
  setStatus(
    @Param('number') number: string,
    @Body() dto: SetStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.setStatus(number, dto.status, user.email);
  }

  @Auth('support')
  @Post('orders/:number/shipments')
  ship(
    @Param('number') number: string,
    @Body() dto: ShipmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.ship(
      number,
      dto.courier,
      dto.trackingNumber,
      user.email,
    );
  }

  @Auth('support')
  @Post('orders/:number/notes')
  async note(
    @Param('number') number: string,
    @Body() dto: NoteDto,
    @CurrentUser() user: AuthUser,
  ) {
    const order = await this.orders.byNumber(number);
    return this.prisma.orderNote.create({
      data: { orderId: order.id, author: user.email, body: dto.body },
    });
  }

  // Review moderation (ADM-8)

  @Auth('support', 'merchandiser')
  @Get('reviews')
  reviews(@Query() query: ReviewQueryDto) {
    return this.prisma.review.findMany({
      where: { status: query.status ?? 'pending' },
      orderBy: { createdAt: 'asc' },
      include: {
        product: { select: { slug: true, name: true } },
        user: { select: { name: true, email: true } },
      },
      take: 100,
    });
  }

  /** Approving or un-approving adjusts the product's rating incrementally, keeping existing ratings intact. */
  @Auth('support', 'merchandiser')
  @Patch('reviews/:id')
  async moderate(@Param('id') id: string, @Body() dto: ModerateReviewDto) {
    const review = await this.prisma.review.findUnique({
      where: { id },
      include: { product: true },
    });
    if (!review) throw new NotFoundException('Review not found');
    if (review.status === dto.status) return review;
    let { ratingAvg: avg, ratingCount: n } = review.product;
    if (review.status === 'approved') {
      avg = n > 1 ? (avg * n - review.rating) / (n - 1) : 0;
      n -= 1;
    }
    if (dto.status === 'approved') {
      avg = (avg * n + review.rating) / (n + 1);
      n += 1;
    }
    const [updated] = await this.prisma.$transaction([
      this.prisma.review.update({
        where: { id },
        data: { status: dto.status },
      }),
      this.prisma.product.update({
        where: { id: review.productId },
        data: { ratingAvg: avg, ratingCount: n },
      }),
    ]);
    return updated;
  }

  // Customers and roles (ADM-1)

  @Auth('support')
  @Get('users')
  async users(@Query() query: UserQueryDto) {
    const users = await this.prisma.user.findMany({
      where: query.q
        ? {
            OR: [
              { email: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {},
      orderBy: { createdAt: 'desc' },
      take: PAGE,
      include: { _count: { select: { orders: true } } },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
      orders: u._count.orders,
    }));
  }

  @Auth('admin')
  @Patch('users/:id/role')
  async setRole(@Param('id') id: string, @Body() dto: RoleDto) {
    const u = await this.prisma.user.update({
      where: { id },
      data: { role: dto.role },
    });
    // end their sessions so the new role applies on next sign-in
    await this.prisma.session.deleteMany({ where: { userId: id } });
    return { id: u.id, email: u.email, role: u.role };
  }

  // Sales dashboard (ADM-9)

  @Auth('support', 'merchandiser')
  @Get('stats')
  async stats(@Query() query: StatsQueryDto) {
    const days = query.days ?? 30;
    const where = {
      status: { in: BOUGHT },
      paidAt: { gte: new Date(Date.now() - days * DAY) },
    };
    const [totals, top, toFulfil, lowStock] = await Promise.all([
      this.prisma.order.aggregate({
        where,
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.orderItem.groupBy({
        by: ['productSlug', 'nameSnapshot'],
        where: { order: where },
        _sum: { qty: true },
        orderBy: { _sum: { qty: 'desc' } },
        take: 5,
      }),
      this.prisma.order.count({
        where: { status: { in: ['paid', 'processing'] } },
      }),
      this.prisma.$queryRaw<
        [{ count: bigint }]
      >`SELECT COUNT(*) AS count FROM "Sku" WHERE "stock" - "reserved" <= 3`,
    ]);
    const revenue = totals._sum.total ?? 0;
    return {
      days,
      revenue,
      orders: totals._count,
      averageOrderValue: totals._count
        ? Math.round(revenue / totals._count)
        : 0,
      toFulfil,
      lowStockSkus: Number(lowStock[0].count),
      topProducts: top.map((t) => ({
        slug: t.productSlug,
        name: t.nameSnapshot,
        sold: t._sum.qty ?? 0,
      })),
    };
  }
}
