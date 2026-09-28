import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { CreateReviewDto, ReviewQueryDto } from './dto';

const PAGE = 10;
const BOUGHT = ['paid', 'processing', 'shipped', 'delivered'] as const;

/** "Putri Anggraini" -> "Putri A." */
const displayName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest.at(-1)![0]}.` : first;
};

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(slug: string, query: ReviewQueryDto) {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      select: { id: true, ratingAvg: true, ratingCount: true },
    });
    if (!product) throw new NotFoundException("We can't find that product");
    const where = {
      productId: product.id,
      status: 'approved' as const,
      ...(query.fit && { fit: query.fit }),
    };
    const orderBy =
      query.sort === 'highest'
        ? [{ rating: 'desc' as const }, { createdAt: 'desc' as const }]
        : query.sort === 'lowest'
          ? [{ rating: 'asc' as const }, { createdAt: 'desc' as const }]
          : [{ createdAt: 'desc' as const }];
    const page = query.page ?? 1;
    const [rows, total, fit] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy,
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: { user: { select: { name: true } } },
      }),
      this.prisma.review.count({ where }),
      this.prisma.review.groupBy({
        by: ['fit'],
        where: { productId: product.id, status: 'approved' },
        _count: true,
      }),
    ]);
    return {
      summary: {
        average: Math.round(product.ratingAvg * 10) / 10,
        count: product.ratingCount,
        fit: Object.fromEntries(fit.map((f) => [f.fit, f._count])),
      },
      items: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        fit: r.fit,
        title: r.title,
        body: r.body,
        author: displayName(r.user.name),
        verifiedBuyer: true,
        createdAt: r.createdAt,
      })),
      total,
      page,
    };
  }

  /** Only verified buyers can review (PDP-12). Reviews go live after moderation. */
  async create(slug: string, userId: string, dto: CreateReviewDto) {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!product) throw new NotFoundException("We can't find that product");
    const bought = await this.prisma.orderItem.findFirst({
      where: {
        productSlug: slug,
        order: { userId, status: { in: [...BOUGHT] } },
      },
      select: { id: true },
    });
    if (!bought)
      throw new ForbiddenException(
        'Only customers who bought this item can review it.',
      );
    const existing = await this.prisma.review.findUnique({
      where: { productId_userId: { productId: product.id, userId } },
    });
    if (existing)
      throw new ConflictException("You've already reviewed this item.");
    const review = await this.prisma.review.create({
      data: { ...dto, productId: product.id, userId, orderItemId: bought.id },
    });
    return { id: review.id, status: review.status };
  }
}
