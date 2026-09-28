import type { CookieOptions } from 'express';
import { env, REFRESH_TOKEN_DAYS } from '../config';

const DAY = 24 * 60 * 60 * 1000;

export const REFRESH_COOKIE = 'mw_refresh';
export const CART_COOKIE = 'mw_cart';

// SameSite=Lax keeps the cookies off cross-site POSTs (CSRF); the storefront and API share a site
const base = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.production,
});

/** Refresh token: only ever sent to /api/auth. */
export const refreshCookie = (): CookieOptions => ({
  ...base(),
  path: '/api/auth',
  maxAge: REFRESH_TOKEN_DAYS * DAY,
});

/** Guest bag lives 30 days (BAG-7). */
export const cartCookie = (): CookieOptions => ({
  ...base(),
  path: '/',
  maxAge: 30 * DAY,
});
