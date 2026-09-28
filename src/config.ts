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
};

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_DAYS = 30;
export const RESERVATION_MINUTES = 15;
