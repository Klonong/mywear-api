import { defineConfig } from 'prisma/config';

// Load .env with Node's built-in loader (no dotenv dependency)
try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the real environment
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --transpile-only prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
