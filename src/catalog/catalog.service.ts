import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { Gender } from '../generated/prisma/enums';
import { PrismaService } from '../prisma.service';
import type { ProductQueryDto } from './dto';

export const productInclude = {
  category: true,
  colors: {
    orderBy: { sortOrder: 'asc' },
    include: { images: { orderBy: { sortOrder: 'asc' } }, skus: true },
  },
} satisfies Prisma.ProductInclude;

export type ProductRecord = Prisma.ProductGetPayload<{
  include: typeof productInclude;
}>;
type SkuRecord = ProductRecord['colors'][number]['skus'][number];

const SIZE_ORDER = [
  'A/XS',
  'A/S',
  'A/M',
  'A/L',
  'A/XL',
  'A/XXL',
  '110',
  '120',
  '130',
  '140',
  '150',
  '160',
];
const sizeRank = (s: string) =>
  SIZE_ORDER.includes(s) ? SIZE_ORDER.indexOf(s) : 100;
export const available = (s: { stock: number; reserved: number }) =>
  Math.max(0, s.stock - s.reserved);

/** Same shape as the storefront's `Product` type, plus per-colour sizes and ids the client needs to buy. */
export function toProduct(p: ProductRecord) {
  const skus = p.colors.flatMap((c) => c.skus);
  const sales = skus
    .map((s) => s.salePrice)
    .filter((v): v is number => v !== null);
  const sizes = new Map<string, number>();
  for (const s of skus)
    sizes.set(s.size, (sizes.get(s.size) ?? 0) + available(s));
  const sizeList = (list: SkuRecord[]) =>
    [...list].sort((a, b) => sizeRank(a.size) - sizeRank(b.size));

  return {
    slug: p.slug,
    name: p.name,
    gender: p.gender,
    category: p.category.name,
    categorySlug: p.category.slug,
    sport: p.sport,
    blurb: p.description,
    price: skus.length ? Math.min(...skus.map((s) => s.price)) : 0,
    salePrice: sales.length ? Math.min(...sales) : undefined,
    rating: Math.round(p.ratingAvg * 10) / 10,
    reviews: p.ratingCount,
    badge: p.badge ?? undefined,
    notice: p.notice ?? undefined,
    voucherEligible: p.voucherEligible,
    material: p.material,
    fit: p.fit,
    colors: p.colors.map((c) => ({
      name: c.name,
      hex: c.hex,
      tone: c.tone,
      image: c.images[0]?.url,
      images: c.images.map(({ url, alt }) => ({ url, alt })),
      sizes: sizeList(c.skus).map((s) => ({
        label: s.size,
        stock: available(s),
        skuId: s.id,
      })),
    })),
    sizes: [...sizes]
      .sort(([a], [b]) => sizeRank(a) - sizeRank(b))
      .map(([label, stock]) => ({ label, stock })),
    createdAt: p.createdAt,
  };
}
export type ProductDto = ReturnType<typeof toProduct>;

const effectivePrice = (p: ProductDto) => p.salePrice ?? p.price;
const lc = (s: string) => s.toLowerCase();

const FACETS: Record<
  string,
  {
    values: (p: ProductDto) => string[];
    match: (p: ProductDto, v: string) => boolean;
  }
> = {
  category: {
    values: (p) => [p.category],
    match: (p, v) => lc(p.category) === lc(v) || p.categorySlug === lc(v),
  },
  size: {
    values: (p) => p.sizes.map((s) => s.label),
    match: (p, v) => p.sizes.some((s) => s.label === v && s.stock > 0),
  },
  colour: {
    values: (p) => p.colors.map((c) => c.name),
    match: (p, v) => p.colors.some((c) => lc(c.name) === lc(v)),
  },
  badge: {
    values: (p) => (p.badge ? [p.badge] : []),
    match: (p, v) => p.badge === v,
  },
  fit: {
    values: (p) => [p.fit.split(' ')[0]],
    match: (p, v) => lc(p.fit).startsWith(lc(v)),
  },
  sport: { values: (p) => [p.sport], match: (p, v) => lc(p.sport) === lc(v) },
};

const SYNONYMS: Record<string, string> = {
  tee: 'tee t-shirt',
  tshirt: 'tee t-shirt',
  hoody: 'hoodie',
  pants: 'trousers jogger pants',
  jumper: 'sweater knit',
};

/** Every word (or one of its synonyms) must appear in name, category, sport or gender. SRCH-3 lite. */
export function matchesQuery(p: ProductDto, q: string) {
  const hay = lc(
    `${p.name} ${p.category} ${p.sport} ${p.gender} ${p.colors.map((c) => c.name).join(' ')}`,
  );
  return lc(q)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) =>
      (SYNONYMS[word] ?? word).split(' ').some((w) => hay.includes(w)),
    );
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async published(gender?: Gender) {
    const rows = await this.prisma.product.findMany({
      where: { status: 'published', ...(gender && { gender }) },
      include: productInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toProduct);
  }

  /**
   * PLP query: filters are multi-select (comma separated), facet counts use every other active filter (PLP-4).
   * ponytail: filters run in memory over the published catalogue; fine to ~10k SKUs, move to SQL or Meilisearch past that.
   */
  async list(query: ProductQueryDto) {
    const slugs = query.slugs?.split(',');
    const all = (await this.published(query.gender)).filter(
      (p) =>
        (!query.q || matchesQuery(p, query.q)) &&
        (!slugs || slugs.includes(p.slug)),
    );
    const selected = Object.fromEntries(
      Object.keys(FACETS).map((k) => [
        k,
        (query[k as keyof ProductQueryDto] as string | undefined)
          ?.split(',')
          .filter(Boolean) ?? [],
      ]),
    );
    const inPrice = (p: ProductDto) =>
      (query.priceMin === undefined || effectivePrice(p) >= query.priceMin) &&
      (query.priceMax === undefined || effectivePrice(p) <= query.priceMax);
    const passes = (p: ProductDto, skip?: string) =>
      inPrice(p) &&
      Object.entries(FACETS).every(
        ([k, f]) =>
          k === skip ||
          !selected[k].length ||
          selected[k].some((v) => f.match(p, v)),
      );

    const facets = Object.fromEntries(
      Object.entries(FACETS).map(([k, f]) => {
        const pool = all.filter((p) => passes(p, k));
        const values = [...new Set(all.flatMap(f.values))];
        return [
          k,
          values.map((value) => ({
            value,
            count: pool.filter((p) => f.match(p, value)).length,
          })),
        ];
      }),
    );

    const results = all.filter((p) => passes(p));
    const by: Record<string, (a: ProductDto, b: ProductDto) => number> = {
      newest: (a, b) =>
        +b.createdAt - +a.createdAt ||
        Number(b.badge === 'New') - Number(a.badge === 'New'),
      'price-asc': (a, b) => effectivePrice(a) - effectivePrice(b),
      'price-desc': (a, b) => effectivePrice(b) - effectivePrice(a),
      rating: (a, b) => b.rating - a.rating || b.reviews - a.reviews,
    };
    if (query.sort && by[query.sort]) results.sort(by[query.sort]);

    const page = query.page ?? 1;
    const limit = query.limit ?? 24;
    return {
      items: results.slice((page - 1) * limit, page * limit),
      total: results.length,
      page,
      limit,
      facets,
    };
  }

  async record(slug: string) {
    const p = await this.prisma.product.findFirst({
      where: { slug, status: 'published' },
      include: productInclude,
    });
    if (!p) throw new NotFoundException("We can't find that product");
    return p;
  }

  async detail(slug: string) {
    const product = toProduct(await this.record(slug));
    const others = (await this.published(product.gender)).filter(
      (p) => p.slug !== slug,
    );
    return {
      ...product,
      completeTheLook: others
        .filter((p) => p.categorySlug !== product.categorySlug)
        .slice(0, 6),
      youMayAlsoLike: others
        .filter((p) => p.sport === product.sport)
        .slice(0, 6),
    };
  }

  async categories(gender?: Gender) {
    const rows = await this.prisma.category.findMany({
      where: gender && { gender },
      orderBy: [{ gender: 'asc' }, { sortOrder: 'asc' }],
      include: {
        _count: { select: { products: { where: { status: 'published' } } } },
      },
    });
    return rows.map((c) => ({
      gender: c.gender,
      name: c.name,
      slug: c.slug,
      parentId: c.parentId,
      productCount: c._count.products,
    }));
  }

  /** Search overlay: matching categories + top 4 products after 2 characters (SRCH-2). */
  async suggest(q: string) {
    const products = (await this.published()).filter((p) => matchesQuery(p, q));
    const categories = await this.prisma.category.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      orderBy: [{ gender: 'asc' }, { sortOrder: 'asc' }],
      take: 6,
    });
    return {
      categories: categories.map((c) => ({
        gender: c.gender,
        name: c.name,
        slug: c.slug,
      })),
      products: products.slice(0, 4),
      total: products.length,
    };
  }
}
