import { validateLocalProfile } from '@pulse-field/foundation';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApiApp } from '../create-api-app';
import { RedisThrottlerStorage } from '../rate-limit/redis-throttler.storage';
import { RateLimitStorageUnavailableError } from '../rate-limit/rate-limit.errors';
import { CheckoutConflictError, CheckoutPaymentUnavailableError } from './checkout.errors';
import type { CheckoutPreviewResponseDto, CheckoutResponseDto } from './checkout.dto';
import { CheckoutService } from './checkout.service';

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
  PAYMENT_PROVIDER: 'stub',
  BILLABLE_ADAPTERS_ENABLED: 'false',
});

const address = {
  fullName: 'Guest Buyer',
  line1: '100 Market Street',
  line2: '',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94105',
  countryCode: 'US' as const,
};

const previewResult = {
  paymentProvider: 'stub' as const,
  currency: 'USD' as const,
  policyVersion: 1,
  lines: [],
  subtotalMinor: 4800,
  shippingMinor: 800,
  taxMinor: 396,
  totalMinor: 5996,
  pricingFingerprint: 'a'.repeat(64),
  taxNotice: 'Simulated tax for this local demo only; not tax advice.',
} satisfies CheckoutPreviewResponseDto;

const checkoutResult = {
  ...previewResult,
  orderId: '90000000-0000-4000-8000-000000000001',
  orderReference: 'PF-TEST00000001',
  orderStatus: 'confirmed' as const,
  paymentProvider: 'stub' as const,
  paymentStatus: 'succeeded' as const,
  reservationStatus: 'committed' as const,
  fulfillmentStatus: 'allocated' as const,
  reservationExpiresAt: '2026-09-11T00:10:00.000Z',
  guestOrderAccessToken:
    '00000000-0000-4000-8000-000000000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  guestOrderAccessExpiresAt: '2026-10-11T00:10:00.000Z',
  checkoutStatus: 'confirmed' as const,
} satisfies CheckoutResponseDto;

describe('checkout HTTP contract', () => {
  let app: NestExpressApplication;
  const preview = jest.spyOn(CheckoutService.prototype, 'preview');
  const create = jest.spyOn(CheckoutService.prototype, 'create');
  const increment = jest.spyOn(RedisThrottlerStorage.prototype, 'increment');
  const token = Buffer.alloc(32, 9).toString('base64url');

  beforeAll(async () => {
    app = await createApiApp(profile);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    preview.mockResolvedValue(previewResult);
    create.mockResolvedValue(checkoutResult);
    increment.mockResolvedValue({
      totalHits: 1,
      timeToExpire: 900,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('requires a strict cart If-Match revision for preview', async () => {
    preview.mockRejectedValueOnce(
      new CheckoutConflictError(
        'CART_REVISION_REQUIRED',
        'The cart revision is required for checkout.',
      ),
    );
    const missing = await request(app.getHttpServer())
      .post('/api/v1/checkouts/preview')
      .send({ shippingAddress: address });
    expect(missing.status).toBe(428);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(missing.body).toMatchObject({ code: 'CART_REVISION_REQUIRED' });

    const malformed = await request(app.getHttpServer())
      .post('/api/v1/checkouts/preview')
      .set('If-Match', 'cart-1')
      .send({ shippingAddress: address });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' });
  });

  it('passes the cookie and revision to preview and disables caching', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/checkouts/preview')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-7"')
      .set('origin', 'http://localhost:3000')
      .send({ shippingAddress: address });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.paymentProvider).toBe('stub');
    expect(preview).toHaveBeenLastCalledWith(token, 7, { shippingAddress: address });
  });

  it('returns only a safe current revision for stale preview requests', async () => {
    preview.mockRejectedValueOnce(
      new CheckoutConflictError(
        'CART_REVISION_CONFLICT',
        'The cart changed since it was last read. Refresh and try again.',
        9,
      ),
    );
    const response = await request(app.getHttpServer())
      .post('/api/v1/checkouts/preview')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-7"')
      .send({ shippingAddress: address });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CART_REVISION_CONFLICT', currentRevision: 9 });
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it('requires checkout idempotency and keeps checkout responses uncached', async () => {
    create.mockRejectedValueOnce(
      new CheckoutConflictError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'An idempotency key is required for checkout.',
      ),
    );
    const missing = await request(app.getHttpServer())
      .post('/api/v1/checkouts')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-7"')
      .send({
        shippingAddress: address,
        pricingFingerprint: previewResult.pricingFingerprint,
        paymentMethodReference: 'stub-success',
      });
    expect(missing.status).toBe(428);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(missing.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });

    const response = await request(app.getHttpServer())
      .post('/api/v1/checkouts')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-7"')
      .set('Idempotency-Key', 'checkout-test-key-0001')
      .send({
        shippingAddress: address,
        pricingFingerprint: previewResult.pricingFingerprint,
        paymentMethodReference: 'stub-success',
      });
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns a generic uncached 503 when payment setup is unavailable', async () => {
    create.mockRejectedValueOnce(new CheckoutPaymentUnavailableError());
    const response = await request(app.getHttpServer())
      .post('/api/v1/checkouts')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-7"')
      .set('Idempotency-Key', 'checkout-test-key-0002')
      .send({
        shippingAddress: address,
        pricingFingerprint: previewResult.pricingFingerprint,
        paymentMethodReference: 'stub-success',
      });

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      detail: 'Payment setup is temporarily unavailable. Try again later.',
    });
  });

  it('rejects a browser-supplied payment provider selector', async () => {
    create.mockClear();
    const response = await request(app.getHttpServer())
      .post('/api/v1/checkouts')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-7"')
      .set('Idempotency-Key', 'checkout-test-key-0003')
      .send({
        shippingAddress: address,
        pricingFingerprint: previewResult.pricingFingerprint,
        paymentMethodReference: 'stub-success',
        paymentProvider: 'stripe',
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects cross-site checkout before entering the service', async () => {
    preview.mockClear();
    const response = await request(app.getHttpServer())
      .post('/api/v1/checkouts/preview')
      .set('If-Match', '"cart-7"')
      .set('origin', 'https://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .send({ shippingAddress: address });

    expect(response.status).toBe(403);
    expect(preview).not.toHaveBeenCalled();
  });

  it('fails closed and returns Retry-After when checkout rate limiting is unavailable or blocks', async () => {
    increment.mockRejectedValueOnce(new RateLimitStorageUnavailableError());
    const unavailable = await request(app.getHttpServer())
      .post('/api/v1/checkouts/preview')
      .set('If-Match', '"cart-7"')
      .send({ shippingAddress: address });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: 'RATE_LIMIT_STORAGE_UNAVAILABLE' });

    increment.mockResolvedValueOnce({
      totalHits: 21,
      timeToExpire: 700,
      isBlocked: true,
      timeToBlockExpire: 900,
    });
    const blocked = await request(app.getHttpServer())
      .post('/api/v1/checkouts/preview')
      .set('If-Match', '"cart-7"')
      .send({ shippingAddress: address });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('900');
    expect(blocked.body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('publishes the independent checkout state projections in OpenAPI', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs/openapi.json');
    const properties = response.body.components.schemas.CheckoutResponseDto.properties;
    expect(properties.orderStatus).toBeDefined();
    expect(properties.paymentProvider.enum).toEqual(['stub', 'stripe']);
    expect(properties.paymentStatus).toBeDefined();
    expect(properties.paymentConfiguration).toBeDefined();
    expect(properties.reservationStatus).toBeDefined();
    expect(properties.fulfillmentStatus.nullable).toBe(true);
    expect(properties.reservationExpiresAt).toBeDefined();
    expect(properties.checkoutStatus).toBeDefined();
  });
});
