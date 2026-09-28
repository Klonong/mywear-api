import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { hmacSha256 } from '../src/common/crypto';
import { createApp } from '../src/main';
import { OrdersService } from '../src/orders/orders.service';
import { PrismaService } from '../src/prisma.service';
import { testDatabaseUrl } from './test-db';

process.env.DATABASE_URL = testDatabaseUrl();

const run = Date.now().toString(36);
const TEE = `tee-${run}`;
const LAST = `last-${run}`;
const EXCLUDED = `excl-${run}`;

describe('MyWear API', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => app.getHttpServer() as Server;
  const sku = (slug: string) =>
    prisma.sku.findFirstOrThrow({ where: { color: { product: { slug } } } });
  const add = (agent: TestAgent, slug: string) =>
    agent
      .post('/api/cart/items')
      .send({ slug, color: 'Black', size: 'A/M', qty: 1 });
  const checkout = (email: string) => ({
    email,
    phone: '0812 3456 7890',
    deliveryMethod: 'standard',
    paymentMethod: 'card',
    address: {
      firstName: 'Putri',
      lastName: 'Anggraini',
      line1: 'Jl. Senopati 12',
      city: 'Jakarta',
      postcode: '12190',
    },
  });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    prisma = app.get(PrismaService);
    const category = await prisma.category.upsert({
      where: { gender_slug: { gender: 'women', slug: 'tops' } },
      create: { gender: 'women', name: 'Tops', slug: 'tops' },
      update: {},
    });
    const product = (slug: string, stock: number, extra = {}) =>
      prisma.product.create({
        data: {
          slug,
          name: `Test Tee ${slug}`,
          description: 'Test product',
          gender: 'women',
          categoryId: category.id,
          sport: 'Running',
          material: '100% cotton',
          fit: 'Regular fit.',
          ...extra,
          colors: {
            create: [
              {
                name: 'Black',
                hex: '#111111',
                tone: '#333333',
                skus: {
                  create: [
                    {
                      size: 'A/M',
                      sku: `${slug}-M`.toUpperCase(),
                      price: 200_000,
                      stock,
                    },
                  ],
                },
              },
            ],
          },
        },
      });
    await product(TEE, 5);
    await product(LAST, 1);
    await product(EXCLUDED, 5, {
      voucherEligible: false,
      notice: 'Excluded from vouchers & coupons',
    });
    await prisma.promotion.upsert({
      where: { code: 'FIELD10' },
      create: { code: 'FIELD10', type: 'percent', value: 10 },
      update: {},
    });
  });

  afterAll(() => app.close());

  it('lists products with facets and 404s unknown slugs', async () => {
    const list = await request(http())
      .get('/api/products')
      .query({ gender: 'women', q: run })
      .expect(200);
    const items = list.body.items as { slug: string }[];
    expect(items.map((p) => p.slug).sort()).toEqual(
      [EXCLUDED, LAST, TEE].sort(),
    );
    expect(list.body.facets.size).toContainEqual({ value: 'A/M', count: 3 });
    const detail = await request(http())
      .get(`/api/products/${TEE}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      slug: TEE,
      price: 200_000,
      sizes: [{ label: 'A/M', stock: 5 }],
    });
    await request(http()).get('/api/products/does-not-exist').expect(404);
  });

  it('merges a guest bag on sign-up, applies a promo, and moves stock only once paid', async () => {
    const guest = request.agent(http());
    await add(guest, TEE).expect(201);
    const bag = await guest
      .post('/api/cart/promo')
      .send({ code: 'field10' })
      .expect(201);
    expect(bag.body).toMatchObject({
      subtotal: 200_000,
      discount: 20_000,
      delivery: 25_000,
      total: 205_000,
    });

    const email = `putri-${run}@example.com`;
    const reg = await guest
      .post('/api/auth/register')
      .send({ name: 'Putri Anggraini', email, password: 'correct horse 1' })
      .expect(201);
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    const mine = await guest.get('/api/cart').set(auth).expect(200);
    expect(mine.body).toMatchObject({ count: 1, promoCode: 'FIELD10' });

    const placed = await guest
      .post('/api/checkout')
      .set(auth)
      .send(checkout(email))
      .expect(201);
    const { number, total } = placed.body.order;
    expect(total).toBe(205_000);
    expect(await sku(TEE)).toMatchObject({ stock: 5, reserved: 1 });
    expect((await guest.get('/api/cart').set(auth)).body.count).toBe(0);

    await request(http())
      .post(`/api/payments/mock/${number}/confirm`)
      .send({})
      .expect(200);
    expect(await sku(TEE)).toMatchObject({ stock: 4, reserved: 0 });
    // replaying the payment is a no-op
    await request(http())
      .post(`/api/payments/mock/${number}/confirm`)
      .send({})
      .expect(200);
    expect(await sku(TEE)).toMatchObject({ stock: 4, reserved: 0 });

    const orders = await guest.get('/api/me/orders').set(auth).expect(200);
    expect(orders.body[0]).toMatchObject({ number, status: 'paid' });
    await request(http())
      .get('/api/orders/lookup')
      .query({ number, email: email.toUpperCase() })
      .expect(200);
    await request(http())
      .get('/api/orders/lookup')
      .query({ number, email: 'someone-else@example.com' })
      .expect(404);
  });

  it('sells the last unit exactly once when two shoppers check out together', async () => {
    const [a, b] = [request.agent(http()), request.agent(http())];
    await add(a, LAST).expect(201);
    await add(b, LAST).expect(201);
    const results = await Promise.all(
      [a, b].map((agent, i) =>
        agent
          .post('/api/checkout')
          .send(checkout(`race${i}-${run}@example.com`)),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await sku(LAST)).toMatchObject({ stock: 1, reserved: 1 });
  });

  it('rejects unsigned webhooks and releases stock when payment fails', async () => {
    const guest = request.agent(http());
    await add(guest, TEE).expect(201);
    const placed = await guest
      .post('/api/checkout')
      .send(checkout(`fail-${run}@example.com`))
      .expect(201);
    const { number, total } = placed.body.order;
    const reservedBefore = (await sku(TEE)).reserved;

    const payload = JSON.stringify({
      orderNumber: number,
      status: 'failed',
      amount: total,
    });
    const post = () =>
      request(http())
        .post('/api/payments/webhook')
        .set('Content-Type', 'application/json');
    await post().set('X-MyWear-Signature', 'forged').send(payload).expect(401);
    await post()
      .set(
        'X-MyWear-Signature',
        hmacSha256(process.env.PAYMENT_WEBHOOK_SECRET!, payload),
      )
      .send(payload)
      .expect(200);

    expect((await sku(TEE)).reserved).toBe(reservedBefore - 1);
    expect(await prisma.order.findUnique({ where: { number } })).toMatchObject({
      status: 'cancelled',
    });
  });

  it('releases reservations that expire unpaid', async () => {
    const guest = request.agent(http());
    await add(guest, TEE).expect(201);
    const placed = await guest
      .post('/api/checkout')
      .send(checkout(`late-${run}@example.com`))
      .expect(201);
    const { number } = placed.body.order;
    const reservedBefore = (await sku(TEE)).reserved;
    await prisma.order.update({
      where: { number },
      data: { reservationExpiresAt: new Date(Date.now() - 1000) },
    });

    await app.get(OrdersService).expireReservations();
    expect((await sku(TEE)).reserved).toBe(reservedBefore - 1);
    expect(await prisma.order.findUnique({ where: { number } })).toMatchObject({
      status: 'cancelled',
    });
  });

  it('keeps vouchers off excluded items', async () => {
    const guest = request.agent(http());
    await add(guest, EXCLUDED).expect(201);
    const res = await guest
      .post('/api/cart/promo')
      .send({ code: 'FIELD10' })
      .expect(422);
    expect(res.body.message).toMatch(/excluded from vouchers/);
  });

  it('rotates refresh tokens and keeps customers out of admin routes', async () => {
    const agent = request.agent(http());
    const email = `dimas-${run}@example.com`;
    const reg = await agent
      .post('/api/auth/register')
      .send({ name: 'Dimas Rahman', email, password: 'another pass 2' })
      .expect(201);
    const oldCookie = ([] as string[])
      .concat(reg.headers['set-cookie'])
      .find((c) => c.startsWith('mw_refresh='))!
      .split(';')[0];

    const refreshed = await agent.post('/api/auth/refresh').expect(200);
    await request(http())
      .post('/api/auth/refresh')
      .set('Cookie', oldCookie)
      .expect(401);

    await request(http()).get('/api/admin/stats').expect(401);
    await request(http())
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .expect(403);

    await request(http())
      .post('/api/auth/register')
      .send({ name: 'Dimas', email, password: 'another pass 2' })
      .expect(409);
    await request(http())
      .post('/api/auth/login')
      .send({ email, password: 'wrong password' })
      .expect(401);
    await request(http())
      .post('/api/auth/login')
      .send({ email: email.toUpperCase(), password: 'another pass 2' })
      .expect(200);
  });
});
