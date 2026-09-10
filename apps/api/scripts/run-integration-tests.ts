import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { config as loadEnvironment } from 'dotenv';
import { Client } from 'pg';
import { resolveIntegrationDatabaseUrl } from '../src/testing/integration-database-url';

const scriptDirectory = __dirname;
const apiRoot = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(apiRoot, '..', '..');

loadEnvironment({ path: path.join(apiRoot, '.env') });
loadEnvironment({ path: path.join(repositoryRoot, '.env') });

const developmentDatabaseUrl = process.env.DATABASE_URL;

if (!developmentDatabaseUrl) {
  throw new Error('DATABASE_URL is required to derive the isolated integration database.');
}

const testDatabaseUrl = resolveIntegrationDatabaseUrl(
  developmentDatabaseUrl,
  process.env.TEST_DATABASE_URL,
);
const testUrl = new URL(testDatabaseUrl);
const testDatabaseName = decodeURIComponent(testUrl.pathname.slice(1));
const moduleRequire = createRequire(path.join(scriptDirectory, 'integration-runner.js'));
const prismaRoot = path.dirname(moduleRequire.resolve('prisma/package.json'));
const jestRoot = path.dirname(moduleRequire.resolve('jest/package.json'));
const prismaCli = path.join(prismaRoot, 'build', 'index.js');
const jestCli = path.join(jestRoot, 'bin', 'jest.js');

for (const executable of [prismaCli, jestCli]) {
  if (!existsSync(executable)) {
    throw new Error(`Required test executable is missing: ${executable}`);
  }
}

function run(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
): void {
  const result = spawnSync(command, args, {
    cwd: workingDirectory,
    env: environment,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function ensureTestDatabaseExists(): Promise<void> {
  const maintenanceUrl = new URL(testDatabaseUrl);
  maintenanceUrl.pathname = '/postgres';
  maintenanceUrl.searchParams.delete('schema');

  const client = new Client({ connectionString: maintenanceUrl.href });
  await client.connect();

  try {
    const existing = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [testDatabaseName],
    );

    if (!existing.rows[0]?.exists) {
      try {
        await client.query(`CREATE DATABASE "${testDatabaseName}"`);
      } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== '42P04') {
          throw error;
        }
      }
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  process.stdout.write(
    `Preparing isolated database "${testDatabaseName}" on ${testUrl.hostname}.\n`,
  );

  await ensureTestDatabaseExists();

  run(
    process.execPath,
    [prismaCli, 'migrate', 'deploy'],
    {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
    },
    apiRoot,
  );

  run(
    process.execPath,
    [jestCli, '--config', path.join(repositoryRoot, 'jest.integration.config.cjs'), '--runInBand'],
    {
      ...process.env,
      NODE_ENV: 'test',
      TEST_DATABASE_URL: testDatabaseUrl,
    },
    repositoryRoot,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Integration test setup failed: ${error instanceof Error ? error.message : 'Unknown error.'}\n`,
  );
  process.exitCode = 1;
});
