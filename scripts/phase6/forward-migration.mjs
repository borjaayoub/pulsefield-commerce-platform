import { execFileSync } from 'node:child_process';
// Synthetic predecessor rehearsal; never a development database upgrade.
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { root, load, saveResult } from './runtime.mjs';
const ts = load('node_modules/typescript');
if (process.argv.length !== 2) throw new Error('Usage: node scripts/phase6/forward-migration.mjs');
const { Client } = load('apps/api/node_modules/pg');
const { resolveIntegrationDatabaseUrl } = load('apps/api/src/testing/integration-database-url.ts');
const target = new URL(process.env.DATABASE_URL);
target.pathname = `/phase65_forward_${randomUUID().replaceAll('-', '')}_test`;
const url = resolveIntegrationDatabaseUrl(process.env.DATABASE_URL, target.href);
const name = new URL(url).pathname.slice(1);
process.env.TEST_DATABASE_URL = url;
const { PrismaService } = load('apps/api/src/database/prisma.service.ts');
const { seedPhase3Commerce } = load('apps/api/prisma/seed-commerce.ts');
const { seedInternationalCommerce } = load('apps/api/prisma/seed-international-commerce.ts');
const { CartService } = load('apps/api/src/cart/cart.service.ts');
const { CheckoutService } = load('apps/api/src/checkout/checkout.service.ts');
const legacyPath = path.join(root, 'apps/api/src/checkout/checkout.service.ts');
const legacySource = execFileSync(
  'git',
  ['show', 'a4c2f1c32e2ef59d67fcf318d48a06ba15a2794c:apps/api/src/checkout/checkout.service.ts'],
  { cwd: root, encoding: 'utf8' },
);
const legacyModule = new Module(legacyPath);
legacyModule.filename = legacyPath;
legacyModule.paths = Module._nodeModulePaths(path.dirname(legacyPath));
legacyModule._compile(
  ts.transpileModule(legacySource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  }).outputText,
  legacyPath,
);
const LegacyCheckoutService = legacyModule.exports.CheckoutService;
const NEW_COLUMNS = [
  'commerceMarketVersionId',
  'reportingRateVersionId',
  'reportingSubtotalMinor',
  'reportingShippingMinor',
  'reportingTaxMinor',
  'reportingTotalMinor',
  'reportingRoundingAdjustmentMinor',
];
const { IdempotencyService } = load('apps/api/src/idempotency/idempotency.service.ts');
const { AuditService } = load('apps/api/src/audit/audit.service.ts');
const { StubPaymentProvider } = load('apps/api/src/payments/stub-payment.provider.ts');
const { OrderTimelineService } = load('apps/api/src/orders/order-timeline.service.ts');
const encode = (value) =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
async function main() {
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  maintenance.searchParams.delete('schema');
  const admin = new Client({ connectionString: maintenance.href });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  console.log(`Forward migration rehearsal: ${name}`);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  const prisma = new PrismaService(url);
  try {
    const directory = path.join(root, 'apps/api/prisma/migrations');
    const migrations = fs
      .readdirSync(directory)
      .filter((f) => fs.existsSync(path.join(directory, f, 'migration.sql')))
      .sort();
    const boundary = migrations.indexOf('20261005110000_add_regional_order_evidence');
    assert.equal(boundary, 47);
    for (const migration of migrations.slice(0, boundary)) {
      let source = fs.readFileSync(path.join(directory, migration, 'migration.sql'), 'utf8');
      // Historical migrations add enum values before using them; commit each addition.
      const additions = [...source.matchAll(/^ALTER TYPE [^;]+;/gm)];
      for (const addition of additions) {
        await sql.query(addition[0]);
        source = source.replace(addition[0], '');
      }
      await sql.query(source);
    }
    await seedPhase3Commerce(prisma);
    await prisma.commercePolicyVersion.create({
      data: {
        id: '62000000-0000-4000-8000-000000000001',
        version: 1,
        lifecycle: 'ACTIVE',
        effectiveFrom: new Date('2026-09-10T00:00:00Z'),
        countryCode: 'US',
        currencyCode: 'USD',
        priceBookVersionId: '61000000-0000-4000-8000-000000000001',
        shippingBaseMinor: 800,
        freeShippingThresholdMinor: 12000,
        heavySurchargeMinor: 400,
        heavyThresholdGrams: 2000,
        taxRateBasisPoints: 825,
        reservationDurationSeconds: 600,
        calculationVersion: 'us-usd-2026-09-10',
      },
    });
    await seedInternationalCommerce(prisma);
    // Synthetic predecessor fixture: temporary nullable columns allow today's client
    // to execute the committed legacy checkout. Remove them before migration.
    for (const column of NEW_COLUMNS)
      await sql.query(
        `ALTER TABLE "Order" ADD COLUMN "${column}" ${column.endsWith('Id') ? 'UUID' : 'BIGINT'}`,
      );
    const carts = new CartService(prisma);
    const checkout = new LegacyCheckoutService(
      prisma,
      new IdempotencyService(prisma),
      new AuditService(),
      new StubPaymentProvider(),
      new OrderTimelineService(prisma, Buffer.alloc(32, 8).toString('base64')),
    );
    const address = {
      fullName: 'Guest Buyer',
      line1: '100 Market Street',
      line2: '',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94105',
      countryCode: 'US',
    };
    const cart = await carts.getCurrent(undefined);
    const changed = await carts.setItem(
      cart.token,
      '30000000-0000-4000-8000-000000000001',
      2,
      cart.cart.revision,
    );
    const preview = await checkout.preview(changed.token, changed.revision, {
      shippingAddress: address,
    });
    const request = {
      shippingAddress: address,
      customerEmail: 'checkout@example.test',
      pricingFingerprint: preview.pricingFingerprint,
      paymentMethodReference: 'stub-success',
    };
    const key = randomUUID();
    const original = await checkout.create(
      changed.token,
      changed.revision,
      key,
      request,
      randomUUID(),
    );
    const pendingCart = await carts.getCurrent(undefined);
    const pendingChanged = await carts.setItem(
      pendingCart.token,
      '30000000-0000-4000-8000-000000000001',
      1,
      pendingCart.cart.revision,
    );
    const pendingCheckout = new LegacyCheckoutService(
      prisma,
      new IdempotencyService(prisma),
      new AuditService(),
      {
        createPayment: async () => ({ paymentId: 'stub_synthetic_pending', status: 'processing' }),
      },
      new OrderTimelineService(prisma, Buffer.alloc(32, 8).toString('base64')),
    );
    const pendingPreview = await pendingCheckout.preview(
      pendingChanged.token,
      pendingChanged.revision,
      { shippingAddress: address },
    );
    const pendingRequest = { ...request, pricingFingerprint: pendingPreview.pricingFingerprint };
    const pendingKey = randomUUID();
    const pendingResult = await pendingCheckout.create(
      pendingChanged.token,
      pendingChanged.revision,
      pendingKey,
      pendingRequest,
      randomUUID(),
    );
    assert.equal(pendingResult.checkoutStatus, 'pending_payment');
    const tables = [
      'CommercePolicyVersion',
      'Order',
      'OrderLine',
      'PaymentAttempt',
      'InventoryReservation',
      'InventoryReservationItem',
      'InventoryBalance',
      'InventoryMovement',
      'Cart',
      'CartItem',
      'FulfillmentGroup',
      'FulfillmentGroupItem',
      'AuditRecord',
      'OutboxMessage',
      'IdempotencyRecord',
    ];
    async function snapshot() {
      const result = {};
      for (const table of tables) {
        result[table] = (await sql.query(`SELECT * FROM "${table}" ORDER BY "id"`)).rows;
        if (table === 'Order')
          for (const row of result[table]) for (const column of NEW_COLUMNS) delete row[column];
      }
      result.USPriceBook = (
        await sql.query(`SELECT * FROM "PriceBook" WHERE "code"='US-RETAIL'`)
      ).rows;
      result.USPriceVersion = (
        await sql.query(
          `SELECT * FROM "PriceBookVersion" WHERE "id"='61000000-0000-4000-8000-000000000001'`,
        )
      ).rows;
      result.USPrices = (
        await sql.query(
          `SELECT * FROM "VariantPrice" WHERE "priceBookVersionId"='61000000-0000-4000-8000-000000000001' ORDER BY "id"`,
        )
      ).rows;
      return encode(result);
    }
    for (const column of NEW_COLUMNS)
      await sql.query(`ALTER TABLE "Order" DROP COLUMN "${column}"`);
    const before = await snapshot();
    assert.equal(await prisma.order.count(), 2);
    for (const migration of migrations.slice(boundary))
      await sql.query(fs.readFileSync(path.join(directory, migration, 'migration.sql'), 'utf8'));
    await seedInternationalCommerce(prisma);
    await seedInternationalCommerce(prisma);
    assert.equal(await snapshot(), before);
    assert.equal((await prisma.cart.findFirstOrThrow()).marketCode, 'US');
    const current = new CheckoutService(
      prisma,
      new IdempotencyService(prisma),
      new AuditService(),
      new StubPaymentProvider(),
      new OrderTimelineService(prisma, Buffer.alloc(32, 8).toString('base64')),
    );
    const replay = await current.create(
      changed.token,
      changed.revision,
      key,
      request,
      randomUUID(),
    );
    assert.deepEqual(replay, original);
    assert.equal(await snapshot(), before);
    assert.equal((await prisma.cart.findFirstOrThrow()).marketCode, 'US');
    assert.equal(await prisma.commerceMarketVersion.count(), 4);
    const resumed = await current.create(
      pendingChanged.token,
      pendingChanged.revision,
      pendingKey,
      pendingRequest,
      randomUUID(),
    );
    assert.equal(resumed.checkoutStatus, 'confirmed');
    assert.equal(resumed.orderId, pendingResult.orderId);
    const legacyOrders = await prisma.order.findMany();
    assert.equal(legacyOrders.length, 2);
    for (const order of legacyOrders) {
      assert.equal(order.policyVersionId, '62000000-0000-4000-8000-000000000001');
      for (const column of NEW_COLUMNS) assert.equal(order[column], null);
    }
    saveResult('phase65-forward-result.json', {
      database: name,
      passed: true,
      predecessorMigrations: boundary,
      forwardMigrations: migrations.length - boundary,
      snapshotSha256: createHash('sha256').update(before).digest('hex'),
    });
    console.log(
      `PASS: ${boundary} prior migrations; ${migrations.length - boundary} forward migration; confirmed and pending legacy US orders, 15 legacy tables and US prices unchanged; seed twice; identical confirmed replay without new effects; pending legacy recovery. Snapshot SHA256 ${createHash('sha256').update(before).digest('hex')}`,
    );
  } finally {
    await prisma.$disconnect();
    await sql.end();
  }
}
main().catch(() => {
  console.error('Phase 6 forward migration rehearsal failed; retained target.');
  process.exitCode = 1;
});
