import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
config({ path: path.join(root, 'apps/api/.env'), quiet: true });
config({ path: path.join(root, '.env'), quiet: true });
if (process.argv.length !== 2)
  throw new Error('Usage: node scripts/run-phase6-browser-acceptance.mjs');
for (const port of [3000, 4000]) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () =>
      reject(new Error(`Port ${port} must be free for owned acceptance processes.`)),
    );
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
const source = process.env.DATABASE_URL;
const target = new URL(source);
const name = `phase64_browser_${randomUUID().replaceAll('-', '')}_test`;
target.pathname = `/${name}`;
const { resolveIntegrationDatabaseUrl } = apiRequire(
  './dist/src/testing/integration-database-url.js',
);
resolveIntegrationDatabaseUrl(source, target.href);
const redis = new URL(process.env.EPHEMERAL_REDIS_URL);
if (!['localhost', '127.0.0.1', '::1'].includes(redis.hostname))
  throw new Error('Redis must be loopback.');
const Redis = apiRequire('ioredis');
let redisUrl;
for (let index = 1; index <= 15; index++) {
  if (index === Number(redis.pathname.slice(1))) continue;
  redis.pathname = `/${index}`;
  const client = new Redis(redis.href, { maxRetriesPerRequest: 1 });
  try {
    if ((await client.dbsize()) === 0) redisUrl = redis.href;
  } finally {
    await client.quit();
  }
  if (redisUrl) break;
}
if (!redisUrl) throw new Error('No empty local Redis database available; no data is flushed.');
const env = {
  ...process.env,
  DATABASE_URL: target.href,
  EPHEMERAL_REDIS_URL: redisUrl,
  PAYMENT_PROVIDER: 'stub',
  OUTBOX_RELAY_ENABLED: 'false',
  LOCAL_DEVELOPMENT_PROFILE: 'zero-cost-local',
  WEB_ORIGIN: 'http://localhost:3000',
  NEXT_PUBLIC_API_ORIGIN: 'http://localhost:4000',
  CATALOG_API_ORIGIN: 'http://localhost:4000',
  API_PORT: '4000',
  PHASE6_ACCEPTANCE_DATABASE_NAME: name,
  PLAYWRIGHT_NO_COPY_PROMPT: '1',
};
apiRequire('@pulse-field/foundation').validateLocalProfile(env);
const maintenance = new URL(target);
maintenance.pathname = '/postgres';
maintenance.searchParams.delete('schema');
const client = new (apiRequire('pg').Client)({ connectionString: maintenance.href });
await client.connect();
try {
  await client.query(`CREATE DATABASE "${name}"`);
} finally {
  await client.end();
}
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Acceptance preparation/check failed.');
}
run(
  [
    path.join(path.dirname(apiRequire.resolve('prisma/package.json')), 'build/index.js'),
    'migrate',
    'deploy',
  ],
  path.join(root, 'apps/api'),
);
run([path.join(root, 'apps/api/dist/prisma/seed.js')]);
const fixtures = new (apiRequire('pg').Client)({ connectionString: target.href });
await fixtures.connect();
try {
  await fixtures.query(
    'INSERT INTO "ProductSlug" (id, "productId", slug, "isCanonical") VALUES ($1, $2, $3, false)',
    [randomUUID(), '20000000-0000-4000-8000-000000000001', 'phase64-old-aero'],
  );
} finally {
  await fixtures.end();
}
const children = [];
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.once(signal, () => {
    for (const child of children) if (!child.killed) child.kill();
    process.exit(code);
  });
async function waitFor(url) {
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    if (children.some((child) => child.exitCode !== null))
      throw new Error('Owned process exited before readiness.');
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* Starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Acceptance server readiness timed out.');
}
try {
  children.push(
    spawn(process.execPath, [path.join(root, 'apps/api/dist/src/main.js')], {
      cwd: root,
      env,
      stdio: 'ignore',
      windowsHide: true,
    }),
  );
  children.push(
    spawn(
      process.execPath,
      [
        path.join(root, 'apps/web/node_modules/next/dist/bin/next'),
        'start',
        '-H',
        '127.0.0.1',
        '-p',
        '3000',
      ],
      { cwd: path.join(root, 'apps/web'), env, stdio: 'ignore', windowsHide: true },
    ),
  );
  await waitFor('http://127.0.0.1:4000/api/v1/health');
  await waitFor('http://127.0.0.1:3000/catalog');
  run([
    path.join(root, 'node_modules/@playwright/test/cli.js'),
    'test',
    'apps/web/e2e/phase6-regional-storefront.spec.ts',
    'apps/web/e2e/phase6-regional-seo.spec.ts',
    'apps/web/e2e/catalog-storefront.spec.ts',
    'apps/web/e2e/product-detail-storefront.spec.ts',
    'apps/web/e2e/cart-storefront.spec.ts',
    'apps/web/e2e/homepage-header.spec.ts',
    'apps/web/e2e/homepage-storefront.spec.ts',
    '--workers=1',
  ]);
  // Rehearse real upstream failure only after all live shopping journeys finish.
  const api = children[0];
  const stopped = new Promise((resolve) => api.once('exit', resolve));
  api.kill();
  await stopped;
  const unavailable = await fetch('http://localhost:3000/catalog/aero-tempo-tee?market=MA');
  const html = await unavailable.text();
  if (
    !html.includes('Product unavailable') ||
    html.includes('application/ld+json') ||
    html.includes('rel="alternate"')
  )
    throw new Error('Unavailable upstream fabricated public product SEO evidence.');
  const emptySitemap = await fetch('http://localhost:3000/sitemap.xml');
  if (!emptySitemap.ok || (await emptySitemap.text()).includes('<loc>'))
    throw new Error('Unavailable catalog fabricated sitemap entries.');
  fs.mkdirSync(path.join(root, '.local/acceptance'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.local/acceptance/phase64-browser-result.json'),
    JSON.stringify({
      database: name,
      redisDatabase: new URL(redisUrl).pathname,
      passed: true,
      unavailableUpstream: true,
    }),
  );
  console.log(
    `PASS: Phase 6 storefront browser acceptance; retained ${name}; Redis ${new URL(redisUrl).pathname}; no development data changes.`,
  );
} finally {
  for (const child of children) if (!child.killed) child.kill();
}
