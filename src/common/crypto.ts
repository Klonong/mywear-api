import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

// OWASP scrypt profile: N=2^15, r=8, p=3 (needs ~32 MiB, so raise Node's 32 MiB default cap)
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

const derive = (password: string, salt: Buffer, opts = SCRYPT) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

/** Returns `scrypt$N$r$p$salt$key`, so parameters can be raised later without breaking old hashes. */
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  const [algo, N, r, p, salt, key] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), {
    N: +N,
    r: +r,
    p: +p,
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Opaque random token for cookies and emailed links. Only its hash is stored. */
export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export const hmacSha256 = (secret: string, payload: Buffer | string) =>
  createHmac('sha256', secret).update(payload).digest('hex');
export const safeEqual = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Human-friendly order number, e.g. MW260928-7K2QX */
export function orderNumber(now = new Date()) {
  const ymd = now.toISOString().slice(2, 10).replaceAll('-', '');
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const tail = Array.from(
    { length: 5 },
    () => alphabet[randomInt(alphabet.length)],
  ).join('');
  return `MW${ymd}-${tail}`;
}
