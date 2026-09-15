import type { NestExpressApplication } from '@nestjs/platform-express';
import { validateLocalProfile } from '@pulse-field/foundation';
import request from 'supertest';
import { createApiApp } from '../create-api-app';
import { PaymentWebhookInboxService } from './payment-webhook-inbox.service';
import { StripeWebhookPersistenceUnavailableError } from './payment-webhook.errors';

const profile = validateLocalProfile({
  LOCAL_DEVELOPMENT_PROFILE: 'zero-cost-local',
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://pulsefield:password@localhost:5432/pulsefield',
  QUEUE_REDIS_URL: 'redis://localhost:6379/0',
  EPHEMERAL_REDIS_URL: 'redis://localhost:6380/0',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_ALLOW_EXTERNAL: 'false',
  MESSAGE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  OUTBOX_RELAY_ENABLED: 'false',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  PRODUCT_MEDIA_ROOT: './.local/media',
  WEB_ORIGIN: 'http://localhost:3000',
  API_PORT: '4000',
  WORKER_PORT: '4001',
  PAYMENT_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_local_placeholder',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_local_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_local_placeholder',
  BILLABLE_ADAPTERS_ENABLED: 'false',
});

describe('Stripe webhook HTTP contract', () => {
  let app: NestExpressApplication;
  const accept = jest.spyOn(PaymentWebhookInboxService.prototype, 'accept');

  beforeAll(async () => {
    app = await createApiApp(profile);
    await app.init();
  });

  beforeEach(() => accept.mockReset().mockResolvedValue('accepted'));

  afterAll(async () => {
    accept.mockRestore();
    await app.close();
  });

  it('passes the unmodified JSON bytes to the signed endpoint and returns no-store', async () => {
    const payload = '{"id":"evt_exact", "spacing":true}';
    const response = await request(app.getHttpServer())
      .post('/api/v1/payments/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', 't=1,v1=safe-test-signature')
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(accept).toHaveBeenCalledWith(Buffer.from(payload), 't=1,v1=safe-test-signature');
  });

  it('rejects missing JSON parsing and oversized bodies before persistence', async () => {
    const missingType = await request(app.getHttpServer())
      .post('/api/v1/payments/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=safe-test-signature')
      .send('not-json-content');
    expect(missingType.status).toBe(400);

    const oversized = await request(app.getHttpServer())
      .post('/api/v1/payments/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', 't=1,v1=safe-test-signature')
      .send(`"${'x'.repeat(65_537)}"`);
    expect(oversized.status).toBe(413);
    expect(accept).not.toHaveBeenCalled();
  });

  it('returns a retryable generic failure when durable persistence is unavailable', async () => {
    accept.mockRejectedValueOnce(new StripeWebhookPersistenceUnavailableError());
    const response = await request(app.getHttpServer())
      .post('/api/v1/payments/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', 't=1,v1=safe-test-signature')
      .send('{}');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'STRIPE_WEBHOOK_PERSISTENCE_UNAVAILABLE',
      detail: 'Webhook persistence is temporarily unavailable.',
    });
    expect(JSON.stringify(response.body)).not.toContain('safe-test-signature');
  });

  it('publishes the conditional Stripe webhook contract in OpenAPI', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.paths).toHaveProperty('/api/v1/payments/webhooks/stripe.post');
  });
});
