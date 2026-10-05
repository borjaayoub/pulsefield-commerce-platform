import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'apps/api/package.json'));
const target = process.env.PHASE5_ACCEPTANCE_DATABASE_URL;
const name = process.env.PHASE5_ACCEPTANCE_DATABASE_NAME;
assert.match(name ?? '', /^slice56_processes_[a-f0-9]{32}_test$/u);
assert.equal(new URL(target).pathname, `/${name}`);
const { resolveIntegrationDatabaseUrl } = require('./dist/src/testing/integration-database-url.js');
resolveIntegrationDatabaseUrl(process.env.PHASE5_ACCEPTANCE_SOURCE_DATABASE_URL, target);
const { PrismaService } = require('./dist/src/database/prisma.service.js');
const { AuditService } = require('./dist/src/audit/audit.service.js');
const { IdempotencyService } = require('./dist/src/idempotency/idempotency.service.js');
const {
  InventoryOperationsService,
} = require('./dist/src/inventory/inventory-operations.service.js');
const prisma = new PrismaService(target);
const inventory = new InventoryOperationsService(
  prisma,
  new IdempotencyService(prisma),
  new AuditService(),
  Buffer.alloc(32, 7).toString('base64'),
);
const address = {
  fullName: 'Process acceptance buyer',
  line1: '1 Test Street',
  line2: '',
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  countryCode: 'US',
};

// Real socket source addresses preserve the per-IP protections for 50 distinct
// local clients; no forwarded headers or production rate limits are changed.
function request(client, port, method, endpoint, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        localAddress: client.ip,
        method,
        path: `/api/v1${endpoint}`,
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
          ...(client.cookie ? { Cookie: client.cookie } : {}),
          ...headers,
        },
      },
      (response) => {
        let payload = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          payload += chunk;
        });
        response.on('end', () => {
          const cookie = response.headers['set-cookie']?.find((item) =>
            item.startsWith('pulse_field_cart='),
          );
          if (cookie) client.cookie = cookie.split(';')[0];
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(payload),
              etag: response.headers.etag,
            });
          } catch {
            reject(new Error('Acceptance response was not JSON.'));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Acceptance HTTP timeout.')));
    req.end(text);
  });
}
function status(response, expected) {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; got ${response.status}, code ${response.body?.code ?? 'none'}.`,
  );
}
try {
  // Fixture setup uses the audited owned service only in the guarded test DB.
  assert.equal(await prisma.order.count(), 0);
  const variant = await prisma.productVariant.findUniqueOrThrow({
    where: { sku: 'PF-AERO-BLU-L' },
  });
  const admin = await prisma.user.findFirstOrThrow({
    where: { userRoles: { some: { role: 'ADMINISTRATOR' } } },
  });
  const actor = { id: admin.id, roles: ['ADMINISTRATOR'] };
  for (const row of await prisma.inventoryBalance.findMany({
    where: { variantId: variant.id },
    include: { warehouse: true },
  })) {
    const desired = row.warehouse.code === 'MA-CASA-01' ? 0 : 3;
    if (desired !== row.onHand)
      await inventory.adjust(
        row.id,
        {
          onHandDelta: desired - row.onHand,
          damagedDelta: 0,
          reason: 'Constrain isolated API-process acceptance stock',
        },
        row.version,
        actor,
        randomUUID(),
        randomUUID(),
      );
  }
  const clients = [];
  // Prepare all carts/previews before the simultaneous checkout wave.
  for (let index = 0; index < 50; index += 1) {
    const client = { ip: `127.0.0.${index + 2}`, port: index % 2 ? 4101 : 4100, key: randomUUID() };
    const cart = await request(client, client.port, 'GET', '/cart');
    status(cart, 200);
    const line = await request(
      client,
      client.port,
      'PUT',
      `/cart/items/${variant.id}`,
      { quantity: 2 },
      { 'If-Match': cart.etag },
    );
    status(line, 200);
    client.etag = line.etag;
    const preview = await request(
      client,
      client.port,
      'POST',
      '/checkouts/preview',
      { shippingAddress: address },
      { 'If-Match': client.etag },
    );
    status(preview, 200);
    client.body = {
      shippingAddress: address,
      customerEmail: 'process-acceptance@example.test',
      pricingFingerprint: preview.body.pricingFingerprint,
      paymentMethodReference: 'stub-success',
    };
    clients.push(client);
  }
  const submit = (client, port = client.port) =>
    request(client, port, 'POST', '/checkouts', client.body, {
      'If-Match': client.etag,
      'Idempotency-Key': client.key,
    });
  const responses = await Promise.all(clients.map((client) => submit(client)));
  const statuses = {};
  for (const response of responses)
    statuses[response.status] = (statuses[response.status] ?? 0) + 1;
  console.log(`Initial simultaneous HTTP outcomes: ${JSON.stringify(statuses)}.`);
  const recovered = [];
  for (const [index, response] of responses.entries()) {
    const client = clients[index];
    if (response.status === 201) {
      assert.equal(response.body.checkoutStatus, 'confirmed');
      continue;
    }
    if (response.status === 409) {
      assert.equal(response.body.code, 'INSUFFICIENT_STOCK');
      continue;
    }
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'CHECKOUT_TEMPORARILY_UNAVAILABLE');
    let retry = response;
    let attempts = 0;
    while (retry.status === 503 && attempts < 2) {
      assert.equal(retry.body.code, 'CHECKOUT_TEMPORARILY_UNAVAILABLE');
      attempts += 1;
      retry = await submit(client, client.port === 4100 ? 4101 : 4100);
    }
    assert.ok(attempts >= 1 && attempts <= 2);
    if (retry.status === 201) assert.equal(retry.body.checkoutStatus, 'confirmed');
    else {
      status(retry, 409);
      assert.equal(retry.body.code, 'INSUFFICIENT_STOCK');
    }
    recovered.push({ response: retry, client, attempts });
  }
  console.log(
    `503 recovery outcomes: ${JSON.stringify({ clients: recovered.length, attempts: recovered.reduce((total, item) => total + item.attempts, 0) })}.`,
  );
  const winners = responses
    .map((response, index) => ({ response, client: clients[index] }))
    .filter(({ response }) => response.status === 201)
    .concat(recovered.filter(({ response }) => response.status === 201));
  assert.equal(winners.length, 3);
  assert.equal(await prisma.order.count({ where: { status: 'CONFIRMED' } }), 3);
  assert.equal(await prisma.order.count(), 3);
  assert.equal(await prisma.fulfillmentGroup.count(), 4);
  // With 3 US and 3 EU units and two-unit orders, the minimum-group allocator
  // must produce two single-warehouse orders and one split order.
  const reservations = await prisma.inventoryReservationItem.aggregate({
    _sum: { quantity: true },
  });
  assert.equal(reservations._sum.quantity, 6);
  const allocations = await prisma.fulfillmentGroupItem.aggregate({ _sum: { quantity: true } });
  assert.equal(allocations._sum.quantity, 6);
  const effects = async () => ({
    orders: await prisma.order.count(),
    movements: await prisma.inventoryMovement.count(),
    audits: await prisma.auditRecord.count(),
    outbox: await prisma.outboxMessage.count(),
    allocations: await prisma.fulfillmentGroupItem.count(),
  });
  const before = await effects();
  for (const { client, response } of winners) {
    const replay = await submit(client, client.port === 4100 ? 4101 : 4100);
    status(replay, 201);
    assert.equal(replay.body.orderId, response.body.orderId);
    assert.equal(replay.body.orderReference, response.body.orderReference);
  }
  assert.deepEqual(await effects(), before);
  const balances = await prisma.inventoryBalance.findMany({ where: { variantId: variant.id } });
  assert.equal(balances.length, 3);
  for (const row of balances) {
    for (const bucket of ['onHand', 'reserved', 'allocated', 'damaged'])
      assert.ok(row[bucket] >= 0);
    assert.ok(row.reserved + row.allocated + row.damaged <= row.onHand);
    const ledger = await prisma.inventoryMovement.aggregate({
      where: { warehouseId: row.warehouseId, variantId: variant.id },
      _sum: { onHandDelta: true, reservedDelta: true, allocatedDelta: true, damagedDelta: true },
    });
    assert.deepEqual(ledger._sum, {
      onHandDelta: row.onHand,
      reservedDelta: row.reserved,
      allocatedDelta: row.allocated,
      damagedDelta: row.damaged,
    });
  }
  const report = await inventory.reconciliation(actor, { pageSize: 100, sku: variant.sku });
  assert.equal(report.items.length, 3);
  assert.equal(report.nextCursor, null);
  assert.equal(report.clean, true);
  assert.equal(report.mismatchCount, 0);
  console.log(
    '50 clients across 2 API processes: 3 orders, 4 groups, 6 allocated units; cross-process replay unchanged; 3 balances reconcile.',
  );
} finally {
  await prisma.$disconnect();
}
