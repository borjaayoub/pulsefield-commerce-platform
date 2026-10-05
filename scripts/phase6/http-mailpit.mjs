// Real HTTP plus direct relay/processor delivery; no BullMQ transport claim.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { load, emptyRedisUrl, saveResult } from './runtime.mjs';
if (process.argv.length !== 2) throw new Error('Usage: node scripts/phase6/http-mailpit.mjs');
const { resolveIntegrationDatabaseUrl } = load('apps/api/src/testing/integration-database-url.ts');
const target = new URL(process.env.DATABASE_URL);
const artifact = load('.local/acceptance/phase65-forward-result.json');
const name = artifact.database;
if (artifact.passed !== true || !/^phase65_forward_[a-f0-9]{32}_test$/.test(name))
  throw Error('Run the owned forward rehearsal first.');
target.pathname = '/' + name;
const url = resolveIntegrationDatabaseUrl(process.env.DATABASE_URL, target.href);
const { validateLocalProfile } = load('packages/foundation/dist/index.js');
const { createApiApp } = load('apps/api/dist/src/create-api-app.js');
const { PrismaService } = load('apps/api/dist/src/database/prisma.service.js');
const { OutboxRelayService } = load('apps/api/dist/src/messaging/outbox-relay.service.js');
const { NotificationDeliveryService } = load(
  'apps/api/dist/src/messaging/notification-delivery.service.js',
);
const { OrderConfirmationProcessor } = load(
  'apps/worker/dist/notification/order-confirmation.processor.js',
);
const { MailpitNotificationAdapter } = load(
  'apps/worker/dist/notification/mailpit-notification.adapter.js',
);
const { SEND_ORDER_CONFIRMATION_JOB } = load('packages/contracts/dist/index.js');
const request = load('apps/api/node_modules/supertest');
async function main() {
  const redisUrl = await emptyRedisUrl();
  const profile = validateLocalProfile({
    ...process.env,
    DATABASE_URL: url,
    EPHEMERAL_REDIS_URL: redisUrl,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    OUTBOX_RELAY_ENABLED: 'false',
    PAYMENT_PROVIDER: 'stub',
    SMTP_HOST: '127.0.0.1',
  });
  const prisma = new PrismaService(url);
  const app = await createApiApp(profile);
  await app.listen(0, '127.0.0.1');
  const mail = new MailpitNotificationAdapter(profile);
  const created = [];
  try {
    for (const [market, currency, countryCode, postalCode, total] of [
      ['US', 'USD', 'US', '94105', 11192],
      ['MA', 'MAD', 'MA', '20000', 115200],
      ['EU', 'EUR', 'FR', '75001', 11800],
      ['UK', 'GBP', 'GB', 'SW1A 1AA', 10500],
    ]) {
      const cart = await request(app.getHttpServer()).get('/api/v1/cart');
      assert.equal(cart.status, 200);
      const cookie = cart.headers['set-cookie'][0].split(';')[0];
      const item = await request(app.getHttpServer())
        .put('/api/v1/cart/items/30000000-0000-4000-8000-000000000001')
        .set('Cookie', cookie)
        .set('Origin', profile.WEB_ORIGIN)
        .set('If-Match', cart.headers.etag)
        .send({ quantity: 2 });
      assert.equal(item.status, 200);
      const preview = await request(app.getHttpServer())
        .post('/api/v1/cart/market-preview')
        .set('Cookie', cookie)
        .set('Origin', profile.WEB_ORIGIN)
        .set('If-Match', item.headers.etag)
        .send({ market });
      assert.equal(preview.status, 200);
      const selected = await request(app.getHttpServer())
        .put('/api/v1/cart/market')
        .set('Cookie', cookie)
        .set('Origin', profile.WEB_ORIGIN)
        .set('If-Match', item.headers.etag)
        .send({ market, pricingFingerprint: preview.body.pricingFingerprint });
      assert.equal(selected.status, 200);
      const shippingAddress = {
        fullName: 'Local Rehearsal Buyer',
        line1: '1 Test Road',
        line2: '',
        city: 'Local City',
        countryCode,
        postalCode,
        ...(countryCode === 'US' ? { state: 'CA' } : {}),
      };
      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkouts/preview')
        .set('Cookie', cookie)
        .set('Origin', profile.WEB_ORIGIN)
        .set('If-Match', selected.headers.etag)
        .send({ shippingAddress });
      assert.equal(quote.status, 200);
      assert.equal(quote.body.currency, currency);
      assert.equal(quote.body.totalMinor, total);
      assert.equal(quote.headers['cache-control'], 'no-store');
      assert(!('calculation' in quote.body));
      const key = randomUUID();
      const body = {
        shippingAddress,
        customerEmail: 'buyer@example.test',
        pricingFingerprint: quote.body.pricingFingerprint,
        paymentMethodReference: 'stub-success',
      };
      const create = () =>
        request(app.getHttpServer())
          .post('/api/v1/checkouts')
          .set('Cookie', cookie)
          .set('Origin', profile.WEB_ORIGIN)
          .set('If-Match', selected.headers.etag)
          .set('Idempotency-Key', key)
          .send(body);
      const result = await create();
      assert.equal(result.status, 201);
      assert.equal(result.body.checkoutStatus, 'confirmed');
      assert.equal(result.body.currency, currency);
      assert.equal(result.headers['cache-control'], 'no-store');
      const replay = await create();
      assert.equal(replay.status, 201);
      assert.deepEqual(replay.body, result.body);
      const timeline = await request(app.getHttpServer())
        .get(`/api/v1/orders/${result.body.orderReference}/timeline`)
        .set('Authorization', `Guest ${result.body.guestOrderAccessToken}`);
      assert.equal(timeline.status, 200);
      assert.equal(timeline.body.currency, currency);
      assert.equal(timeline.body.totalMinor, total);
      assert.equal(timeline.headers['cache-control'], 'no-store');
      created.push({ id: result.body.orderId, reference: result.body.orderReference });
    }
    await mail.verify();
    const deliveries = new NotificationDeliveryService(prisma);
    const processor = new OrderConfirmationProcessor(
      profile.MESSAGE_ENCRYPTION_KEY_BASE64,
      profile.WEB_ORIGIN,
      mail,
    );
    const publisher = {
      publishOrderConfirmation: async (data) => {
        await processor.process({
          id: data.sourceEventId,
          name: SEND_ORDER_CONFIRMATION_JOB,
          data,
        });
        await deliveries.applyOutcome({
          version: 1,
          sourceEventId: data.sourceEventId,
          status: 'accepted',
          workerAttemptCount: 1,
        });
      },
    };
    const relay = new OutboxRelayService(prisma, {}, {}, deliveries, publisher, profile);
    for (let i = 0; i < 12; i++) if (!(await relay.drainOnce())) break;
    const delivered = await prisma.notificationDelivery.count({
      where: { orderId: { in: created.map((o) => o.id) }, status: 'ACCEPTED' },
    });
    assert.equal(delivered, 4);
    const inbox = await (await fetch('http://127.0.0.1:8025/api/v1/messages?limit=100')).json();
    for (const order of created) {
      const message = inbox.messages.find((m) => m.Subject.includes(order.reference));
      assert(message);
      const detail = await (
        await fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)
      ).json();
      assert(detail.Text.includes(`/orders/${order.reference}#access=`));
      assert(!detail.Text.includes('USD'));
    }
    saveResult('phase65-http-mailpit-result.json', {
      database: name,
      redisDatabase: new URL(redisUrl).pathname,
      passed: true,
      markets: 4,
      acceptedDeliveries: delivered,
      transport: 'direct-relay-processor',
    });
    console.log(
      `PASS: ${name}; real HTTP create/preview/identical replay/timeline for four markets; local Redis ${new URL(redisUrl).pathname}; 4 captured Mailpit confirmations and ACCEPTED ledgers. Direct relay/worker invocation, not a BullMQ recovery rehearsal. Email retains link-only body; currency is verified on linked API timelines.`,
    );
  } finally {
    mail.close();
    await app.close();
    await prisma.$disconnect();
  }
}
main().catch(() => {
  console.error('Phase 6 HTTP/Mailpit rehearsal failed; retained target.');
  process.exitCode = 1;
});
