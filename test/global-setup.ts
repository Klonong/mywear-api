import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { testDatabaseUrl } from './test-db';

/** Creates the test database if needed and applies migrations to it. */
export default async function globalSetup() {
  const url = new URL(testDatabaseUrl());
  const name = url.pathname.slice(1);
  const server = new URL(url);
  server.pathname = '/postgres';
  const client = new Client({ connectionString: server.toString() });
  await client.connect();
  const exists = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
  );
  if (!exists.rowCount)
    await client.query(`CREATE DATABASE "${name.replaceAll('"', '')}"`);
  await client.end();
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'ignore',
  });
}
