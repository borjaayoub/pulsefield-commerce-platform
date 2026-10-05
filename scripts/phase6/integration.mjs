import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, load } from './runtime.mjs';
// Keep the original runner's file selection, target guards, migrations and Jest config.
const { resolveIntegrationDatabaseUrl } = load('apps/api/src/testing/integration-database-url.ts');
const target = new URL(process.env.DATABASE_URL);
target.pathname = '/phase65_integration_' + randomUUID().replaceAll('-', '') + '_test';
process.env.TEST_DATABASE_URL = resolveIntegrationDatabaseUrl(
  process.env.DATABASE_URL,
  target.href,
);
process.argv = [
  process.execPath,
  path.join(root, 'apps/api/scripts/run-integration-tests.ts'),
  ...process.argv.slice(2),
];
load('apps/api/scripts/run-integration-tests.ts');
