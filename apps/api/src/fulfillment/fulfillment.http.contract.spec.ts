import { validateLocalProfile } from '@pulse-field/foundation';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApiApp } from '../create-api-app';
import { FulfillmentGroupStatus, RoleName } from '../generated/prisma/enums';
import { SESSION_COOKIE_NAME } from '../identity/identity.constants';
import { SessionService } from '../identity/session.service';
import { FulfillmentConflictError } from './fulfillment.errors';
import { FulfillmentService } from './fulfillment.service';

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
  STRIPE_ENABLED: 'false',
  BILLABLE_ADAPTERS_ENABLED: 'false',
});

const sessionId = Buffer.alloc(32, 3).toString('base64url');
const csrfToken = Buffer.alloc(32, 5).toString('base64url');
const groupId = '90000000-0000-4000-8000-000000000001';
const session = {
  user: {
    id: '90000000-0000-4000-8000-000000000002',
    email: 'fulfiller@example.test',
    roles: [RoleName.FULFILLER],
  },
  authenticatedAt: new Date().toISOString(),
  idleExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  csrfToken,
};

const responseBody = {
  id: groupId,
  orderId: '90000000-0000-4000-8000-000000000003',
  warehouseId: '90000000-0000-4000-8000-000000000004',
  status: FulfillmentGroupStatus.PICKING,
  version: 2,
  pickingStartedAt: new Date().toISOString(),
  packedAt: null,
  shippedAt: null,
  deliveredAt: null,
  carrierCode: null,
  trackingReference: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('staff fulfillment HTTP contract', () => {
  let app: NestExpressApplication;
  const current = jest.spyOn(SessionService.prototype, 'current');
  const transition = jest.spyOn(FulfillmentService.prototype, 'transition');

  beforeAll(async () => {
    app = await createApiApp(profile);
    await app.init();
  });

  beforeEach(() => {
    current.mockResolvedValue(session);
    transition.mockResolvedValue(responseBody);
  });

  afterAll(async () => {
    await app.close();
    current.mockRestore();
    transition.mockRestore();
  });

  it('requires exact revision, CSRF, origin, and idempotency headers and returns a new ETag', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/staff/fulfillment-groups/${groupId}/transitions`)
      .set('origin', profile.WEB_ORIGIN)
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .set('If-Match', '"fulfillment-1"')
      .set('Idempotency-Key', 'fulfillment-http-0001')
      .send({ targetStatus: 'PICKING', reason: 'Begin the pick.' });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.etag).toBe('"fulfillment-2"');
    expect(response.body).toEqual(responseBody);
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        fulfillmentGroupId: groupId,
        expectedVersion: 1,
        idempotencyKey: 'fulfillment-http-0001',
        targetStatus: 'PICKING',
        reason: 'Begin the pick.',
      }),
      expect.objectContaining({ actor: expect.objectContaining({ id: session.user.id }) }),
    );
  });

  it('does not cache a safe revision conflict response', async () => {
    transition.mockRejectedValueOnce(
      new FulfillmentConflictError(
        'FULFILLMENT_REVISION_CONFLICT',
        'The fulfillment group changed since it was last read. Refresh and try again.',
        4,
      ),
    );
    const response = await request(app.getHttpServer())
      .post(`/api/v1/staff/fulfillment-groups/${groupId}/transitions`)
      .set('origin', profile.WEB_ORIGIN)
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .set('If-Match', '"fulfillment-1"')
      .set('Idempotency-Key', 'fulfillment-http-0002')
      .send({ targetStatus: 'PICKING', reason: 'Begin the pick.' });

    expect(response.status).toBe(409);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      code: 'FULFILLMENT_REVISION_CONFLICT',
      currentVersion: 4,
    });
  });

  it('rejects an administrator-only session because fulfillment is fulfiller-only', async () => {
    current.mockResolvedValueOnce({
      ...session,
      user: { ...session.user, roles: [RoleName.ADMINISTRATOR] },
    });
    const response = await request(app.getHttpServer())
      .post(`/api/v1/staff/fulfillment-groups/${groupId}/transitions`)
      .set('origin', profile.WEB_ORIGIN)
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .set('If-Match', '"fulfillment-1"')
      .set('Idempotency-Key', 'fulfillment-http-0003')
      .send({ targetStatus: 'PICKING', reason: 'Begin the pick.' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(transition).not.toHaveBeenCalled();
  });

  it('rejects cross-site and missing-CSRF requests before the mutation', async () => {
    const crossSite = await request(app.getHttpServer())
      .post(`/api/v1/staff/fulfillment-groups/${groupId}/transitions`)
      .set('origin', 'https://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .set('If-Match', '"fulfillment-1"')
      .set('Idempotency-Key', 'fulfillment-http-0004')
      .send({ targetStatus: 'PICKING', reason: 'Begin the pick.' });
    expect(crossSite.status).toBe(403);

    const missingCsrf = await request(app.getHttpServer())
      .post(`/api/v1/staff/fulfillment-groups/${groupId}/transitions`)
      .set('origin', profile.WEB_ORIGIN)
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('If-Match', '"fulfillment-1"')
      .set('Idempotency-Key', 'fulfillment-http-0005')
      .send({ targetStatus: 'PICKING', reason: 'Begin the pick.' });
    expect(missingCsrf.status).toBe(403);
    expect(transition).not.toHaveBeenCalled();
  });

  it('publishes the protected route and transition schema in OpenAPI', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.paths).toHaveProperty(
      '/api/v1/staff/fulfillment-groups/{id}/transitions.post',
    );
    expect(
      response.body.components.schemas.FulfillmentTransitionDto.properties.targetStatus,
    ).toBeDefined();
    expect(response.body.components.schemas.FulfillmentGroupDto.properties.version).toBeDefined();
  });
});
