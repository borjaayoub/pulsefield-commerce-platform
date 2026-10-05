import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Use the existing guarded source runner without the Windows TSX startup path.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
require('dotenv').config({ path: path.join(root, 'apps/api/.env'), quiet: true });
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  });
  module._compile(compiled.outputText, filename);
};

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--full')) {
  throw new Error('Usage: pnpm test:phase5 [--full]');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const { resolveIntegrationDatabaseUrl } = require(
  path.join(root, 'apps/api/src/testing/integration-database-url.ts'),
);
const candidate = new URL(process.env.DATABASE_URL);
candidate.pathname = `/slice56_${randomUUID().replaceAll('-', '')}_test`;
process.env.TEST_DATABASE_URL = resolveIntegrationDatabaseUrl(
  process.env.DATABASE_URL,
  candidate.href,
);
// Fixtures retain the owned database for inspection. No DROP or dev DB mutation.
process.argv = [process.execPath, path.join(root, 'apps/api/scripts/run-integration-tests.ts')];
if (!args.includes('--full')) {
  process.argv.push('apps/api/src/inventory/phase5-concurrency.integration.spec.ts');
}
require(path.join(root, 'apps/api/scripts/run-integration-tests.ts'));
