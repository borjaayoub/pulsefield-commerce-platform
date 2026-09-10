import { config as loadEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig, env } from 'prisma/config';

// `pnpm --filter` runs Prisma from apps/api, whereas an editor may invoke it
// at the repository root. Support both without copying a secret-bearing .env.
loadEnvironment({ path: resolve(process.cwd(), '.env') });
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
