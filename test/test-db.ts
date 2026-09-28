/** E2E tests run against `<dev database>_test` on the same server, never the dev data. */
export function testDatabaseUrl() {
  try {
    process.loadEnvFile();
  } catch {
    // real environment
  }
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.pathname.endsWith('_test')) url.pathname = `${url.pathname}_test`;
  return url.toString();
}
