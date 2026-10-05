import { validateLocalProfile } from '@pulse-field/foundation';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApiApp } from '../create-api-app';
import {
  CartRevisionConflictError,
  CartRevisionRequiredError,
  CartMarketPreviewStaleError,
} from './cart.errors';
import { CommerceConfigurationUnavailableError } from '../checkout/shopping-configuration.service';
import { CartService } from './cart.service';
import type { CartDto } from './cart.dto';
import { RedisThrottlerStorage } from '../rate-limit/redis-throttler.storage';
import { RateLimitStorageUnavailableError } from '../rate-limit/rate-limit.errors';

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

describe('anonymous cart HTTP contract', () => {
  let app: NestExpressApplication;
  const getCurrent = jest.spyOn(CartService.prototype, 'getCurrent');
  const setItem = jest.spyOn(CartService.prototype, 'setItem');
  const removeItem = jest.spyOn(CartService.prototype, 'removeItem');
  const previewMarket = jest.spyOn(CartService.prototype, 'previewMarket');
  const confirmMarket = jest.spyOn(CartService.prototype, 'confirmMarket');
  const increment = jest.spyOn(RedisThrottlerStorage.prototype, 'increment');
  const token = Buffer.alloc(32, 8).toString('base64url');
  const cart = {
    market: 'US',
    taxTreatment: 'exclusive',
    revision: 2,
    currency: 'USD',
    subtotalMinor: 4800,
    totalMinor: 4800,
    hasUnavailableItems: false,
    expiresAt: '2026-10-10T00:00:00.000Z',
    items: [],
  } satisfies CartDto;

  beforeAll(async () => {
    app = await createApiApp(profile);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    previewMarket.mockResolvedValue({
      cart: { ...cart, market: 'EU', currency: 'EUR' },
      token,
      pricingFingerprint: 'a'.repeat(64),
    });
    confirmMarket.mockResolvedValue({
      cart: { ...cart, revision: 3, market: 'EU', currency: 'EUR' },
      token,
      pricingFingerprint: 'a'.repeat(64),
    });
    getCurrent.mockResolvedValue({ cart: { ...cart, revision: 1 }, token, createdCookie: false });
    setItem.mockResolvedValue({ cart, revision: 2, token, createdCookie: false, changed: true });
    removeItem.mockResolvedValue({
      cart,
      revision: 2,
      token,
      createdCookie: false,
      changed: false,
    });
    increment.mockResolvedValue({
      totalHits: 1,
      timeToExpire: 900,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('returns a no-store repricing preview and confirms it with scoped cookie and ETag', async () => {
    const preview = await request(app.getHttpServer())
      .post('/api/v1/cart/market-preview')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-2"')
      .send({ market: 'EU' });
    expect(preview.status).toBe(200);
    expect(preview.headers['cache-control']).toBe('no-store');
    expect(preview.headers.etag).toBe('"cart-2"');
    expect(preview.body).toMatchObject({
      cart: { market: 'EU', currency: 'EUR', taxTreatment: 'exclusive' },
      pricingFingerprint: 'a'.repeat(64),
    });
    expect(preview.body.token).toBeUndefined();
    expect(previewMarket).toHaveBeenCalledWith(token, 'EU', 2);
    const confirmed = await request(app.getHttpServer())
      .put('/api/v1/cart/market')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-2"')
      .send({ market: 'EU', pricingFingerprint: 'a'.repeat(64) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    expect(confirmed.headers.etag).toBe('"cart-3"');
    expect(confirmed.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(confirmMarket).toHaveBeenCalledWith(token, 'EU', 'a'.repeat(64), 2);
  });

  it.each([
    { market: 'eu' },
    { market: 'GB' },
    { market: ['EU'] },
    { market: 'EU', currency: 'USD' },
    {},
  ])('rejects invalid market preview body %j before service execution', async (body) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/market-preview')
      .set('If-Match', '"cart-2"')
      .send(body);
    expect(response.status).toBe(400);
    expect(previewMarket).not.toHaveBeenCalled();
  });

  it.each([
    { market: 'EU' },
    { market: 'EU', pricingFingerprint: 'bad' },
    { market: 'EU', pricingFingerprint: 'a'.repeat(64), prices: [1] },
  ])('rejects invalid market confirmation body %j before execution', async (body) => {
    const response = await request(app.getHttpServer())
      .put('/api/v1/cart/market')
      .set('If-Match', '"cart-2"')
      .send(body);
    expect(response.status).toBe(400);
    expect(confirmMarket).not.toHaveBeenCalled();
  });

  it('enforces origin protection and fails closed when the rate limiter is unavailable on market endpoints', async () => {
    const crossSite = await request(app.getHttpServer())
      .put('/api/v1/cart/market')
      .set('Origin', 'http://localhost:9999')
      .set('If-Match', '"cart-2"')
      .send({ market: 'EU', pricingFingerprint: 'a'.repeat(64) });
    expect(crossSite.status).toBe(403);
    expect(confirmMarket).not.toHaveBeenCalled();
    increment.mockRejectedValueOnce(new RateLimitStorageUnavailableError());
    const unavailable = await request(app.getHttpServer())
      .post('/api/v1/cart/market-preview')
      .send({ market: 'EU' });
    expect(unavailable.status).toBe(503);
    expect(previewMarket).not.toHaveBeenCalled();
  });

  it('maps missing revisions, stale repricing and unavailable configuration to safe public errors', async () => {
    previewMarket.mockRejectedValueOnce(new CartRevisionRequiredError());
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/cart/market-preview')
          .send({ market: 'EU' })
      ).status,
    ).toBe(428);
    confirmMarket.mockRejectedValueOnce(new CartMarketPreviewStaleError());
    const stale = await request(app.getHttpServer())
      .put('/api/v1/cart/market')
      .set('If-Match', '"cart-2"')
      .send({ market: 'EU', pricingFingerprint: 'a'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CART_MARKET_PREVIEW_STALE');
    previewMarket.mockRejectedValueOnce(new CommerceConfigurationUnavailableError());
    const missing = await request(app.getHttpServer())
      .post('/api/v1/cart/market-preview')
      .set('If-Match', '"cart-2"')
      .send({ market: 'EU' });
    expect(missing.status).toBe(503);
    expect(missing.body.code).toBe('COMMERCE_CONFIGURATION_UNAVAILABLE');
    expect(JSON.stringify(missing.body)).not.toContain(token);
  });

  it('requires and strictly parses a revision for an existing cookie cart', async () => {
    setItem.mockRejectedValueOnce(new CartRevisionRequiredError());
    const missing = await request(app.getHttpServer())
      .put('/api/v1/cart/items/30000000-0000-4000-8000-000000000001')
      .set('cookie', `pulse_field_cart=${token}`)
      .send({ quantity: 1 });
    expect(missing.status).toBe(428);
    expect(missing.body).toMatchObject({ code: 'CART_REVISION_REQUIRED' });
    setItem.mockClear();
    const malformed = await request(app.getHttpServer())
      .put('/api/v1/cart/items/30000000-0000-4000-8000-000000000001')
      .set('If-Match', 'cart-1')
      .send({ quantity: 1 });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' });
    expect(setItem).not.toHaveBeenCalled();
  });

  it('returns safe current revision on a stale mutation', async () => {
    setItem.mockRejectedValueOnce(new CartRevisionConflictError(9));
    const response = await request(app.getHttpServer())
      .put('/api/v1/cart/items/30000000-0000-4000-8000-000000000001')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-2"')
      .send({ quantity: 1 });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CART_REVISION_CONFLICT', currentRevision: 9 });
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it('allows a first mutation without a valid cart and returns scoped cookie and ETag', async () => {
    setItem.mockResolvedValueOnce({ cart, revision: 2, token, createdCookie: true, changed: true });
    const response = await request(app.getHttpServer())
      .put('/api/v1/cart/items/30000000-0000-4000-8000-000000000001')
      .send({ quantity: 1 });
    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"cart-2"');
    expect(response.headers['set-cookie']?.[0]).toContain('pulse_field_cart=');
    expect(response.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(response.headers['set-cookie']?.[0]).toContain('SameSite=Lax');
  });

  it('exposes ETag to the storefront and disables cart caching', async () => {
    const getResponse = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `pulse_field_cart=${token}`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers['access-control-expose-headers']).toContain('ETag');
    expect(getResponse.headers['cache-control']).toBe('no-store');
    expect(getResponse.headers.etag).toBe('"cart-1"');
    expect(getResponse.headers['set-cookie']?.[0]).toContain(`pulse_field_cart=${token}`);
    expect(getResponse.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(getResponse.headers['set-cookie']?.[0]).toContain('SameSite=Lax');
    expect(getResponse.headers['set-cookie']?.[0]).toContain('Path=/api/v1');
    expect(getResponse.body).not.toHaveProperty('token');

    const putResponse = await request(app.getHttpServer())
      .put('/api/v1/cart/items/30000000-0000-4000-8000-000000000001')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-1"')
      .send({ quantity: 1 });
    expect(putResponse.status).toBe(200);
    expect(putResponse.headers['access-control-expose-headers']).toContain('ETag');
    expect(putResponse.headers['cache-control']).toBe('no-store');
    expect(putResponse.headers.etag).toBe('"cart-2"');
    expect(putResponse.headers['set-cookie']?.[0]).toContain(`pulse_field_cart=${token}`);
    expect(putResponse.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(putResponse.headers['set-cookie']?.[0]).toContain('SameSite=Lax');
    expect(putResponse.headers['set-cookie']?.[0]).toContain('Path=/api/v1');
    expect(putResponse.body).not.toHaveProperty('token');

    const deleteResponse = await request(app.getHttpServer())
      .delete('/api/v1/cart/items/30000000-0000-4000-8000-000000000001')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `pulse_field_cart=${token}`)
      .set('If-Match', '"cart-2"');
    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.headers['set-cookie']?.[0]).toContain(`pulse_field_cart=${token}`);
    expect(deleteResponse.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(deleteResponse.headers['set-cookie']?.[0]).toContain('SameSite=Lax');
    expect(deleteResponse.headers['set-cookie']?.[0]).toContain('Path=/api/v1');
  });

  it('rejects unknown fields and cross-site mutations before the service', async () => {
    const unknown = await request(app.getHttpServer())
      .put('/api/v1/cart/items/30000000-0000-4000-8000-000000000001')
      .send({ quantity: 1, userId: 'not-accepted' });
    expect(unknown.status).toBe(400);
    const crossSite = await request(app.getHttpServer())
      .put('/api/v1/cart/items/30000000-0000-4000-8000-000000000001')
      .set('origin', 'http://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .set('If-Match', '"cart-1"')
      .send({ quantity: 1 });
    expect(crossSite.status).toBe(403);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('fails closed and returns Retry-After when cart rate limits trigger', async () => {
    increment.mockRejectedValueOnce(new RateLimitStorageUnavailableError());
    const unavailable = await request(app.getHttpServer()).get('/api/v1/cart');
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: 'RATE_LIMIT_STORAGE_UNAVAILABLE' });

    increment.mockResolvedValueOnce({
      totalHits: 121,
      timeToExpire: 700,
      isBlocked: true,
      timeToBlockExpire: 900,
    });
    const blocked = await request(app.getHttpServer()).get('/api/v1/cart');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('900');
    expect(blocked.body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('publishes cart routes and currentRevision in OpenAPI', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs/openapi.json');
    expect(response.body.paths['/api/v1/cart'].get).toBeDefined();
    expect(response.body.paths['/api/v1/cart/items/{variantId}'].put).toBeDefined();
    expect(response.body.paths['/api/v1/cart/items/{variantId}'].delete).toBeDefined();
    expect(
      response.body.components.schemas.ProblemDetailsDto.properties.currentRevision,
    ).toBeDefined();
  });
});
