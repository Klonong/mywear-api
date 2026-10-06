const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable ${key}`);
  return value;
};

/** Environment, read lazily so main.ts can load .env first. Missing required values fail at boot. */
export const env = {
  get production() {
    return process.env.NODE_ENV === 'production';
  },
  get port() {
    return Number(process.env.PORT ?? 4000);
  },
  get webOrigin() {
    return process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  },
  get databaseUrl() {
    return required('DATABASE_URL');
  },
  get jwtSecret() {
    return required('JWT_SECRET');
  },
  get paymentWebhookSecret() {
    return required('PAYMENT_WEBHOOK_SECRET');
  },
  /** Cloudflare R2 for product images. Optional: without it the API runs and uploads answer 503. */
  get r2() {
    const e = process.env;
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = e;
    const { R2_BUCKET, R2_PUBLIC_URL } = e;
    if (
      !R2_ACCOUNT_ID ||
      !R2_ACCESS_KEY_ID ||
      !R2_SECRET_ACCESS_KEY ||
      !R2_BUCKET ||
      !R2_PUBLIC_URL
    )
      return null;
    return {
      accountId: R2_ACCOUNT_ID,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      bucket: R2_BUCKET,
      publicUrl: R2_PUBLIC_URL.replace(/\/+$/, ''),
    };
  },
};

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_DAYS = 30;
export const RESERVATION_MINUTES = 15;
