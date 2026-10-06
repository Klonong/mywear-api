# MyWear API

NestJS 11 + Prisma 7 + PostgreSQL API for the MyWear storefront (`../my-wear`). Implements the endpoints in `files/prd.md` §7.2: catalogue, search, bag, checkout with stock reservation, payments, accounts, wishlist, reviews, stock alerts, newsletter and the admin back office.

Money is always integer IDR. All routes live under `/api`. Interactive docs: **http://localhost:4000/api/docs** (OpenAPI JSON at `/api/docs-json`).

## Run it

```bash
npm install            # also generates the Prisma client
npm run db:up          # Postgres 17 in Docker on localhost:5433
npm run db:migrate     # apply migrations
npm run db:seed        # storefront catalogue, categories, promo codes, admin user
npm run start:dev      # http://localhost:4000/api
```

Copy `.env.example` to `.env` first if you don't have one. The seed creates the admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` and the demo codes `FIELD10` (10% off) and `FREESHIP` (free delivery over IDR 200,000).

## Tests

```bash
npm test               # unit tests (pricing rules)
npm run test:e2e       # end-to-end against a separate <db>_test database, created automatically
```

The e2e suite covers the risky paths: guest bag merge on sign-up, promo rules, checkout and payment moving stock exactly once, the last unit selling exactly once under concurrent checkouts, forged webhook rejection, reservation expiry, refresh-token rotation and role checks.

## How the storefront talks to it

- **CORS + cookies.** `WEB_ORIGIN` (default `http://localhost:3000`) may call the API with credentials. Always send `credentials: 'include'`.
- **Auth.** `POST /api/auth/login` or `/register` returns `{ accessToken, user }`. Send `Authorization: Bearer <accessToken>` (15 min). The refresh token is an httpOnly cookie scoped to `/api/auth`: on a 401, call `POST /api/auth/refresh` and retry. Tokens rotate, and logout revokes them.
- **Guest bag.** The first `POST /api/cart/items` sets an httpOnly `mw_cart` cookie. Signing in merges that bag into the member's bag automatically (BAG-7).
- **Wishlist.** Signed-out saves stay in localStorage; after sign-in, send them to `POST /api/me/wishlist/merge`.
- **Product shape.** `GET /api/products` and `/api/products/:slug` return the same fields as the storefront's `Product` type (`lib/data.ts`), plus `colors[].sizes` with per-colour stock and `categorySlug`.

## Endpoints

| Area | Routes |
|---|---|
| Catalogue | `GET /categories?gender=` · `GET /products?gender&category&size&colour&badge&fit&sport&priceMin&priceMax&q&sort&page&limit` (comma-separated multi-select, facet counts included) · `GET /products/:slug` (+ complete-the-look / you-may-also-like) · `GET /search/suggest?q=` |
| Reviews | `GET /products/:slug/reviews?sort=&fit=` · `POST /products/:slug/reviews` (verified buyers, moderated) |
| Auth | `POST /auth/register` · `/login` · `/refresh` · `/logout` · `/forgot-password` · `/reset-password` |
| Account | `GET/PATCH/DELETE /me` · `PATCH /me/password` · `GET/POST /me/addresses` · `PATCH/DELETE /me/addresses/:id` · `GET /me/wishlist` · `PUT/DELETE /me/wishlist/:slug` · `POST /me/wishlist/merge` |
| Bag | `GET /cart` · `POST /cart/items` `{slug,color,size,qty}` · `PATCH/DELETE /cart/items/:id` · `DELETE /cart` · `POST/DELETE /cart/promo` |
| Checkout | `POST /checkout` · `GET /me/orders` · `GET /me/orders/:number` · `POST /me/orders/:number/returns` · `GET /orders/lookup?number=&email=` |
| Payments | `POST /payments/webhook` (HMAC signed) · `POST /payments/mock/:number/confirm` (dev only) |
| Marketing | `POST /stock-alerts` · `POST /newsletter` · `POST /newsletter/confirm` |
| Admin: catalogue (merchandiser) | products CRUD + archive, colours, images, `POST /admin/uploads` (multipart `file` → Cloudflare R2, returns `url`), SKUs, `GET /admin/inventory`, CSV export/import at `/admin/inventory.csv`, categories, promotions |
| Admin: operations (support) | orders list/detail, status changes, shipments, notes · review moderation · customers · `PATCH /admin/users/:id/role` (admin) · `GET /admin/stats` |
| Health | `GET /health` |

Roles: `admin` can do everything; `merchandiser` manages catalogue, inventory and promotions; `support` manages orders, reviews and customers.

## Checkout, stock and payments

1. `POST /checkout` turns the bag into an order in `pending_payment` and **reserves** each SKU for 15 minutes with an atomic `UPDATE … WHERE stock - reserved >= qty`, so the last unit can only be sold once (CHK-6).
2. The gateway confirms with `POST /payments/webhook`. The `X-MyWear-Signature` header must be the hex HMAC-SHA256 of the raw body using `PAYMENT_WEBHOOK_SECRET`. Body: `{ orderNumber, status: 'paid' | 'failed', amount, providerRef }`. Paid moves reserved units out of stock; failed releases them. Replays are no-ops.
3. Unpaid reservations are released every minute. A payment that arrives after expiry is recorded and the order is flagged for a refund.
4. In development the checkout response includes `payment.confirmUrl`: POST to it to simulate the gateway.

Order status flow: `pending_payment → paid → processing → shipped → delivered`, plus `cancelled`, `return_requested`, `returned`, `refunded`. Admins can only make the moves listed in `TRANSITIONS` (`src/orders/orders.service.ts`); cancelling a paid order or receiving a return puts the goods back in stock.

## Not wired to real services yet

These are stubbed on purpose and marked with `ponytail:` comments:

- **Payment gateway**: the `mock` provider. Plug Midtrans / Xendit / Stripe into `OrdersService.checkout` (hosted payment URL) and refunds into `setStatus`.
- **Email**: `MailService` logs to the console. Swap in Resend or SendGrid.
- **Image upload**: `POST /admin/uploads` streams through the API to Cloudflare R2 (JPEG/PNG/WebP/AVIF checked by file signature, 5 MB cap). Set the `R2_*` variables in `.env`; without them uploads answer 503. Replaced images are not deleted from the bucket, and large/frequent uploads would be better as presigned PUTs.
- **Search and filters** run in memory over the published catalogue: fine to ~10k SKUs, then move to SQL or Meilisearch.
- **Redis** isn't used: carts, sessions and reservations live in Postgres, which is enough for one region.
