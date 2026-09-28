/**
 * Seeds categories, the storefront catalogue (seed-products.json, exported from my-wear/lib/data.ts),
 * demo promo codes and the admin account. Safe to re-run: existing rows are left alone.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import seedProducts from './seed-products.json';
import { hashPassword } from '../src/common/crypto';
import { PrismaClient } from '../src/generated/prisma/client';
import type { Badge, Gender } from '../src/generated/prisma/enums';

try {
  process.loadEnvFile();
} catch {
  // real environment
}

type SeedProduct = {
  slug: string;
  name: string;
  gender: string;
  category: string;
  sport: string;
  blurb: string;
  price: number;
  salePrice?: number;
  rating: number;
  reviews: number;
  badge?: string;
  notice?: string;
  material: string;
  fit: string;
  colors: { name: string; hex: string; tone: string; image?: string }[];
  sizes: { label: string; stock: number }[];
};
const products = seedProducts as SeedProduct[];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const GENDERS: Gender[] = ['women', 'men', 'kids'];
const CATEGORIES = [
  'Tops',
  'Bottoms',
  'Outerwear',
  'Knitwear',
  'Innerwear',
  'Accessories',
];
const code = (...parts: string[]) =>
  parts
    .join('-')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-');

async function main() {
  for (const gender of GENDERS) {
    for (const [i, name] of CATEGORIES.entries()) {
      await prisma.category.upsert({
        where: { gender_slug: { gender, slug: name.toLowerCase() } },
        create: { gender, name, slug: name.toLowerCase(), sortOrder: i },
        update: {},
      });
    }
  }

  const base = Date.now() - products.length * 60_000;
  let created = 0;
  for (const [i, p] of products.entries()) {
    if (await prisma.product.findUnique({ where: { slug: p.slug } })) continue;
    const gender = p.gender as Gender;
    const category = await prisma.category.findUniqueOrThrow({
      where: { gender_slug: { gender, slug: p.category.toLowerCase() } },
    });
    await prisma.product.create({
      data: {
        slug: p.slug,
        name: p.name,
        description: p.blurb,
        gender,
        categoryId: category.id,
        sport: p.sport,
        material: p.material,
        fit: p.fit,
        badge: (p.badge as Badge | undefined) ?? null,
        notice: p.notice ?? null,
        voucherEligible: !p.notice,
        ratingAvg: p.rating,
        ratingCount: p.reviews,
        // keep the storefront's order for "Recommended"
        createdAt: new Date(base + i * 60_000),
        colors: {
          create: p.colors.map((c, ci) => ({
            name: c.name,
            hex: c.hex,
            tone: c.tone,
            sortOrder: ci,
            images: c.image
              ? {
                  create: [
                    {
                      url: c.image,
                      alt: `${p.name}, ${c.name}`,
                      sortOrder: 0,
                    },
                  ],
                }
              : undefined,
            skus: {
              create: p.sizes.map((s) => ({
                size: s.label,
                sku: code(p.slug, c.name, s.label),
                price: p.price,
                salePrice: p.salePrice ?? null,
                stock: s.stock,
              })),
            },
          })),
        },
      },
    });
    created++;
  }

  await prisma.promotion.upsert({
    where: { code: 'FIELD10' },
    create: { code: 'FIELD10', type: 'percent', value: 10 },
    update: {},
  });
  await prisma.promotion.upsert({
    where: { code: 'FREESHIP' },
    create: { code: 'FREESHIP', type: 'free_delivery', minSpend: 200_000 },
    update: {},
  });

  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: 'MyWear Admin',
        role: 'admin',
        passwordHash: await hashPassword(password),
      },
      update: { role: 'admin' },
    });
  }

  console.log(
    `Seeded: ${created} new products, ${GENDERS.length * CATEGORIES.length} categories, promos FIELD10 + FREESHIP${email ? `, admin ${email}` : ''}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
