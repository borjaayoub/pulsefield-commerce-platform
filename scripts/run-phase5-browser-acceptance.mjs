import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
loadEnv({ path: path.join(root, 'apps/api/.env'), override: false, quiet: true });
loadEnv({ path: path.join(root, '.env'), override: false, quiet: true });

const processMode = process.argv.length === 3 && process.argv[2] === '--processes';
if (process.argv.length !== 2 && !processMode)
  throw new Error('Usage: pnpm test:phase5:browser or pnpm test:phase5:processes');
const ports = processMode ? [4100, 4101] : [4000];
const diagnosticsEnabled = processMode && process.env.PHASE5_ACCEPTANCE_DIAGNOSTICS === 'true';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
for (const key of ['PHASE3_DEMO_ADMIN_PASSWORD', 'PHASE3_DEMO_FULFILLER_PASSWORD']) {
  if (!process.env[key]) throw new Error(`${key} is required in the ignored local environment.`);
}
for (const file of [
  'dist/src/main.js',
  'dist/prisma/seed.js',
  'dist/src/testing/integration-database-url.js',
]) {
  if (!fs.existsSync(path.join(root, 'apps/api', file)))
    throw new Error('Run pnpm build before browser acceptance.');
}

const database = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(database.hostname))
  throw new Error('DATABASE_URL must target loopback PostgreSQL.');
const name = `slice56_${processMode ? 'processes' : 'browser'}_${randomUUID().replaceAll('-', '')}_test`;
const target = new URL(databaseUrl);
target.pathname = `/${name}`;
const { resolveIntegrationDatabaseUrl } = apiRequire(
  './dist/src/testing/integration-database-url.js',
);
resolveIntegrationDatabaseUrl(databaseUrl, target.href);
const maintenance = new URL(target);
maintenance.pathname = '/postgres';
const redisBase = new URL(process.env.EPHEMERAL_REDIS_URL ?? 'redis://127.0.0.1:6380/0');
if (!['localhost', '127.0.0.1', '::1'].includes(redisBase.hostname))
  throw new Error('EPHEMERAL_REDIS_URL must target loopback Redis.');

function portFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function chooseRedis() {
  const Redis = apiRequire('ioredis');
  const configured = Number.parseInt(redisBase.pathname.slice(1) || '0', 10);
  for (let index = 1; index <= 15; index += 1) {
    if (index === configured) continue;
    const candidate = new URL(redisBase);
    candidate.pathname = `/${index}`;
    const client = new Redis(candidate.href, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await client.connect();
      const size = await client.dbsize();
      await client.quit();
      if (size === 0) return candidate.href;
    } catch {
      client.disconnect();
    }
  }
  throw new Error('No empty loopback Redis logical database is available in 1..15.');
}

async function waitFor(url, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The owned child may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

const { Client } = apiRequire('pg');
const apiChildren = [];
const diagnostics = new Map();
let testChild;
let redisUrl;
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    if (testChild && testChild.exitCode === null && testChild.signalCode === null) testChild.kill();
    for (const child of apiChildren) if (!child.killed) child.kill();
    process.exit(code);
  });
}
try {
  for (const port of ports) {
    if (!(await portFree(port))) throw new Error(`API port ${port} is already in use.`);
  }
  if (!processMode) await waitFor('http://127.0.0.1:3000/catalog');
  const { validateLocalProfile } = apiRequire('@pulse-field/foundation');
  const preflight = {
    ...process.env,
    DATABASE_URL: target.href,
    EPHEMERAL_REDIS_URL: process.env.EPHEMERAL_REDIS_URL,
    LOCAL_DEVELOPMENT_PROFILE: 'zero-cost-local',
    PAYMENT_PROVIDER: 'stub',
    OUTBOX_RELAY_ENABLED: 'true',
    API_PORT: '4000',
  };
  validateLocalProfile(preflight);
  redisUrl = await chooseRedis();
  const maintenanceClient = new Client({ connectionString: maintenance.href });
  await maintenanceClient.connect();
  await maintenanceClient.query(`CREATE DATABASE "${name}"`);
  await maintenanceClient.end();

  const childEnv = {
    ...process.env,
    DATABASE_URL: target.href,
    EPHEMERAL_REDIS_URL: redisUrl,
    PAYMENT_PROVIDER: 'stub',
    OUTBOX_RELAY_ENABLED: 'true',
    LOCAL_DEVELOPMENT_PROFILE: 'zero-cost-local',
    API_PORT: '4000',
    PHASE5_ACCEPTANCE_DATABASE_NAME: name,
    PHASE5_ACCEPTANCE_DATABASE_URL: target.href,
    PHASE5_ACCEPTANCE_SOURCE_DATABASE_URL: databaseUrl,
    PLAYWRIGHT_API_ORIGIN: 'http://localhost:4000',
    PLAYWRIGHT_WEB_ORIGIN: 'http://localhost:3000',
    WEB_ORIGIN: 'http://localhost:3000',
    PHASE5_ACCEPTANCE_SKU: 'PF-AERO-BLU-L',
    PHASE3_DEMO_MODE: 'true',
    PLAYWRIGHT_NO_COPY_PROMPT: '1',
  };
  const prismaCli = path.join(
    path.dirname(apiRequire.resolve('prisma/package.json')),
    'build',
    'index.js',
  );
  const migration = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: path.join(root, 'apps/api'),
    env: childEnv,
    stdio: 'ignore',
  });
  if (migration.status !== 0) throw new Error('Owned browser database migration failed.');
  const seed = spawnSync(process.execPath, [path.join(root, 'apps/api/dist/prisma/seed.js')], {
    cwd: root,
    env: childEnv,
    stdio: 'ignore',
  });
  if (seed.status !== 0) throw new Error('Owned browser database seed failed.');
  for (const port of ports) {
    const child = spawn(
      process.execPath,
      [
        ...(diagnosticsEnabled
          ? [
              '--import',
              pathToFileURL(path.join(root, 'scripts/phase5-process-diagnostics.mjs')).href,
            ]
          : []),
        path.join(root, 'apps/api/dist/src/main.js'),
      ],
      {
        cwd: root,
        env: { ...childEnv, API_PORT: String(port) },
        stdio: diagnosticsEnabled ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
        windowsHide: true,
      },
    );
    apiChildren.push(child);
    if (diagnosticsEnabled)
      child.on('message', (message) => {
        if (message?.kind !== 'phase5-error-classification') return;
        if (!['P2034', 'P2028', 'P2002', '40001', '40P01', 'other'].includes(message.code)) return;
        if (typeof message.retryable !== 'boolean') return;
        const key = `${message.code}:retryable=${message.retryable}`;
        diagnostics.set(key, (diagnostics.get(key) ?? 0) + 1);
      });
    await waitFor(`http://127.0.0.1:${port}/api/v1/health`);
  }
  if (processMode) {
    if (new Set(apiChildren.map((child) => child.pid)).size !== 2)
      throw new Error('The rehearsal requires two distinct API process IDs.');
    console.log(`Owned API process IDs: ${apiChildren.map((child) => child.pid).join(', ')}.`);
  }
  const runner = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
  const result = await new Promise((resolve, reject) => {
    testChild = spawn(
      process.execPath,
      processMode
        ? [path.join(root, 'scripts/phase5-process-acceptance.mjs')]
        : [runner, 'test', 'apps/web/e2e/phase5-live-acceptance.spec.ts', '--workers=1'],
      { cwd: root, env: childEnv, stdio: 'inherit', windowsHide: true },
    );
    testChild.once('error', reject);
    testChild.once('exit', (code) => resolve({ status: code }));
  });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  console.log(
    `Phase 5 ${processMode ? 'API-process' : 'browser'} acceptance ${result.status === 0 ? 'passed' : 'failed'} against owned database ${name}.`,
  );
} finally {
  if (testChild && testChild.exitCode === null && testChild.signalCode === null) testChild.kill();
  if (diagnosticsEnabled)
    console.log(
      `Sanitized server error classifications: ${JSON.stringify(Object.fromEntries(diagnostics))}.`,
    );
  for (const child of apiChildren) if (!child.killed) child.kill();
}
