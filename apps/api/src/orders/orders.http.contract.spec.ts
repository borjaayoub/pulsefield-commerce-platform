import { validateLocalProfile } from '@pulse-field/foundation';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApiApp } from '../create-api-app';
import { RedisThrottlerStorage } from '../rate-limit/redis-throttler.storage';
import { RateLimitStorageUnavailableError } from '../rate-limit/rate-limit.errors';
import { createGuestOrderAccessToken } from './guest-order-access';
import { OrderTimelineService } from './order-timeline.service';

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

describe('guest order timeline HTTP contract', () => {
  let app: NestExpressApplication;
  const read = jest.spyOn(OrderTimelineService.prototype, 'read');
  const increment = jest.spyOn(RedisThrottlerStorage.prototype, 'increment');
  const token = createGuestOrderAccessToken(
    '90000000-0000-4000-8000-000000000001',
    profile.MESSAGE_ENCRYPTION_KEY_BASE64,
    '80000000-0000-4000-8000-000000000001',
  ).token;

  beforeAll(async () => {
    app = await createApiApp(profile);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    increment.mockResolvedValue({
      totalHits: 1,
      timeToExpire: 900,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    read.mockResolvedValue({
      orderReference: 'PF-TEST00000001',
      status: 'confirmed',
      currency: 'USD',
      subtotalMinor: 1000,
      shippingMinor: 0,
      taxMinor: 80,
      totalMinor: 1080,
      lines: [],
      events: [],
      accessExpiresAt: '2026-10-14T00:00:00.000Z',
    });
  });

  it('reads through a redacted authorization header and disables caching', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/orders/PF-TEST00000001/timeline')
      .set('Authorization', `Guest ${token}`)
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(read).toHaveBeenCalledWith('PF-TEST00000001', token);
    expect(increment).toHaveBeenCalledTimes(2);
  });

  it('fails closed when guest-order rate limiting is unavailable', async () => {
    increment.mockRejectedValueOnce(new RateLimitStorageUnavailableError());
    await request(app.getHttpServer())
      .get('/api/v1/orders/PF-TEST00000001/timeline')
      .set('Authorization', `Guest ${token}`)
      .expect(503);
    expect(read).not.toHaveBeenCalled();
  });

  it('allows the browser preflight authorization header', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/orders/PF-TEST00000001/timeline')
      .set('Origin', profile.WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization')
      .expect(204);
    expect(response.headers['access-control-allow-headers'].toLowerCase()).toContain(
      'authorization',
    );
  });
});
