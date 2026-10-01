import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { InventoryOperationsController } from './inventory-operations.controller';
import { InventoryOperationsReadController } from './inventory-operations-read.controller';
import { REQUIRED_ROLES_METADATA } from '../identity/require-roles.decorator';
import { RoleName } from '../generated/prisma/enums';
import { validateLocalProfile } from '@pulse-field/foundation';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApiApp } from '../create-api-app';
import { SessionService } from '../identity/session.service';
import { SESSION_COOKIE_NAME } from '../identity/identity.constants';
import { InventoryOperationsService } from './inventory-operations.service';
import { InventoryOperationConflict } from './inventory-operations.errors';

const httpProfile = validateLocalProfile({
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

describe('inventory operations route contracts', () => {
  it('requires administrator metadata on every mutation', () => {
    for (const method of ['adjust', 'threshold', 'create', 'transition'] as const) {
      expect(
        Reflect.getMetadata(
          REQUIRED_ROLES_METADATA,
          InventoryOperationsController.prototype[method],
        ),
      ).toEqual([RoleName.ADMINISTRATOR]);
    }
  });
  it('requires administrator metadata on every protected projection', () => {
    for (const method of ['low', 'reconcile', 'queue', 'detail'] as const) {
      expect(
        Reflect.getMetadata(
          REQUIRED_ROLES_METADATA,
          InventoryOperationsReadController.prototype[method],
        ),
      ).toEqual([RoleName.ADMINISTRATOR]);
    }
  });
  it('enforces real session and administrator guards before a mutation', async () => {
    let app: NestExpressApplication | undefined;
    const current = jest
      .spyOn(SessionService.prototype, 'current')
      .mockResolvedValue(undefined as never);
    const adjust = jest.spyOn(InventoryOperationsService.prototype, 'adjust');
    try {
      app = await createApiApp(httpProfile);
      await app.init();
      const response = await request(app.getHttpServer())
        .post('/api/v1/staff/inventory/balances/90000000-0000-4000-8000-000000000001/adjustments')
        .set('origin', httpProfile.WEB_ORIGIN)
        .set('cookie', `${SESSION_COOKIE_NAME}=missing`)
        .send({ onHandDelta: 1, damagedDelta: 0, reason: 'HTTP guard' });
      expect(response.status).toBe(401);
      expect(adjust).not.toHaveBeenCalled();
    } finally {
      await app?.close();
      current.mockRestore();
      adjust.mockRestore();
    }
  });
});

describe('inventory operations HTTP route matrix', () => {
  const id = '90000000-0000-4000-8000-000000000001';
  const csrf = Buffer.alloc(32, 9).toString('base64url');
  const sid = Buffer.alloc(32, 8).toString('base64url');
  const admin = {
    user: {
      id: '90000000-0000-4000-8000-000000000002',
      email: 'admin@example.test',
      roles: [RoleName.ADMINISTRATOR],
    },
    authenticatedAt: new Date().toISOString(),
    idleExpiresAt: new Date(Date.now() + 600000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 600000).toISOString(),
    csrfToken: csrf,
  };
  let app: NestExpressApplication;
  let current: jest.SpyInstance;
  const spies: Record<string, jest.SpyInstance> = {};
  const routes = [
    {
      method: 'post',
      path: `/api/v1/staff/inventory/balances/${id}/adjustments`,
      body: { onHandDelta: 1, damagedDelta: 0, reason: 'Cycle count' },
      version: '"inventory-1"',
      key: 'matrix-adjust',
      name: 'adjust',
      status: 200,
    },
    {
      method: 'post',
      path: `/api/v1/staff/inventory/balances/${id}/thresholds`,
      body: { lowStockThreshold: 2, reason: 'Threshold update' },
      version: '"inventory-1"',
      key: 'matrix-threshold',
      name: 'threshold',
      status: 200,
    },
    {
      method: 'post',
      path: '/api/v1/staff/inventory/transfers',
      body: {
        sourceWarehouseId: id,
        destinationWarehouseId: '90000000-0000-4000-8000-000000000002',
        lines: [{ variantId: id, quantity: 1 }],
        reason: 'Transfer request',
      },
      key: 'matrix-create',
      name: 'createTransfer',
      status: 201,
    },
    {
      method: 'post',
      path: `/api/v1/staff/inventory/transfers/${id}/transitions`,
      body: { targetStatus: 'IN_TRANSIT', reason: 'Dispatch' },
      version: '"transfer-1"',
      key: 'matrix-transition',
      name: 'transition',
      status: 200,
    },
    {
      method: 'get',
      path: '/api/v1/staff/operations/inventory-low-stock',
      name: 'lowStock',
      status: 200,
    },
    {
      method: 'get',
      path: '/api/v1/staff/operations/inventory-reconciliation',
      name: 'reconciliation',
      status: 200,
    },
    {
      method: 'get',
      path: '/api/v1/staff/operations/inventory-transfers',
      name: 'listTransfers',
      status: 200,
    },
    {
      method: 'get',
      path: `/api/v1/staff/operations/inventory-transfers/${id}`,
      name: 'getTransfer',
      status: 200,
    },
  ] as const;
  beforeAll(async () => {
    app = await createApiApp(httpProfile);
    await app.init();
    current = jest.spyOn(SessionService.prototype, 'current');
    for (const name of [
      'adjust',
      'threshold',
      'createTransfer',
      'transition',
      'lowStock',
      'reconciliation',
      'listTransfers',
      'getTransfer',
    ])
      spies[name] = jest.spyOn(InventoryOperationsService.prototype, name as never);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    current.mockResolvedValue(admin);
    for (const route of routes)
      spies[route.name].mockResolvedValue(
        route.name === 'createTransfer'
          ? { id, version: 1, etag: '"transfer-1"' }
          : route.name.startsWith('get')
            ? { id, version: 1 }
            : route.name.startsWith('low') ||
                route.name.startsWith('reconciliation') ||
                route.name.startsWith('list')
              ? { items: [], nextCursor: null, pageScoped: true }
              : {
                  id,
                  version: 2,
                  etag: route.name === 'transition' ? '"transfer-2"' : '"inventory-2"',
                },
      );
  });
  afterAll(async () => {
    await app.close();
    current.mockRestore();
    Object.values(spies).forEach((spy) => spy.mockRestore());
  });
  const send = (route: (typeof routes)[number]) => {
    const client = request(app.getHttpServer());
    let req = client[route.method](route.path)
      .set('origin', httpProfile.WEB_ORIGIN)
      .set('cookie', `${SESSION_COOKIE_NAME}=${sid}`)
      .set('x-csrf-token', csrf);
    if ('version' in route && route.version) req = req.set('If-Match', route.version);
    if ('key' in route) req = req.set('Idempotency-Key', route.key);
    if ('body' in route) req = req.send(route.body);
    return req;
  };
  it.each(routes)('authorizes $name with expected status and no-store', async (route) => {
    const response = await send(route);
    expect(response.status).toBe(route.status);
    expect(response.headers['cache-control']).toBe('no-store');
    if (route.method === 'post') {
      expect(response.headers.etag).toBe(response.body.etag);
      expect(response.body.etag).toBe(
        route.name === 'transition'
          ? '"transfer-2"'
          : route.name === 'createTransfer'
            ? '"transfer-1"'
            : '"inventory-2"',
      );
    }
    expect(spies[route.name]).toHaveBeenCalled();
    const call = spies[route.name].mock.calls.at(-1) as unknown[] | undefined;
    if (
      route.name === 'adjust' ||
      route.name === 'threshold' ||
      route.name === 'transition' ||
      route.name === 'getTransfer'
    )
      expect(call?.[0]).toBe(id);
    if (route.name === 'createTransfer') {
      expect(call?.[0]).toEqual(route.body);
      expect(call?.[1]).toMatchObject({ id: admin.user.id, roles: [RoleName.ADMINISTRATOR] });
      expect(call?.[2]).toBe(route.key);
      expect(call?.[3]).toEqual(expect.any(String));
    }
    if (route.name === 'adjust' || route.name === 'threshold' || route.name === 'transition')
      expect(call?.[4]).toBe(route.key);
  });
  it.each(routes)('rejects $name without a session', async (route) => {
    current.mockResolvedValueOnce(undefined as never);
    const response = await send(route);
    expect(response.status).toBe(401);
    expect(spies[route.name]).not.toHaveBeenCalled();
  });
  it.each(routes)('rejects $name for a fulfiller', async (route) => {
    current.mockResolvedValueOnce({
      ...admin,
      user: { ...admin.user, roles: [RoleName.FULFILLER] },
    } as never);
    const response = await send(route);
    expect(response.status).toBe(403);
    expect(spies[route.name]).not.toHaveBeenCalled();
  });
  it.each(routes)('rejects $name for stale MFA', async (route) => {
    current.mockResolvedValueOnce({
      ...admin,
      authenticatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    } as never);
    const response = await send(route);
    expect(response.status).toBe(403);
    expect(spies[route.name]).not.toHaveBeenCalled();
  });
  it.each(routes)('rejects $name cross-site', async (route) => {
    const response = send(route)
      .set('origin', 'https://attacker.example')
      .set('sec-fetch-site', 'cross-site');
    expect((await response).status).toBe(403);
    expect(spies[route.name]).not.toHaveBeenCalled();
  });
  it.each(routes.filter((route) => route.method === 'post'))(
    'rejects $name with missing CSRF',
    async (route) => {
      const response = await send(route).unset('x-csrf-token');
      expect(response.status).toBe(403);
      expect(spies[route.name]).not.toHaveBeenCalled();
    },
  );
  it.each(routes.filter((route) => route.method === 'post' && 'version' in route))(
    'rejects $name without If-Match',
    async (route) => {
      const response = await send({ ...route, version: undefined } as never);
      expect(response.status).toBe(428);
      expect(spies[route.name]).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'bad balance UUID',
      path: '/api/v1/staff/inventory/balances/not-a-uuid/adjustments',
      body: { onHandDelta: 1, damagedDelta: 0, reason: 'Bad UUID' },
      version: '"inventory-1"',
      key: 'invalid-uuid',
    },
    {
      name: 'unknown body field',
      path: `/api/v1/staff/inventory/balances/${id}/adjustments`,
      body: { onHandDelta: 1, damagedDelta: 0, reason: 'Unknown field', extra: true },
      version: '"inventory-1"',
      key: 'unknown-field',
    },
    {
      name: 'unsafe integer',
      path: `/api/v1/staff/inventory/balances/${id}/adjustments`,
      body: { onHandDelta: 1000001, damagedDelta: 0, reason: 'Too large' },
      version: '"inventory-1"',
      key: 'unsafe-integer',
    },
    {
      name: 'malformed if-match',
      path: `/api/v1/staff/inventory/balances/${id}/adjustments`,
      body: { onHandDelta: 1, damagedDelta: 0, reason: 'Bad tag' },
      version: '"transfer-1"',
      key: 'bad-if-match',
    },
  ])('rejects $name before service delegation', async ({ path, body, version, key }) => {
    const response = await request(app.getHttpServer())
      .post(path)
      .set('origin', httpProfile.WEB_ORIGIN)
      .set('cookie', `${SESSION_COOKIE_NAME}=${sid}`)
      .set('x-csrf-token', csrf)
      .set('If-Match', version)
      .set('Idempotency-Key', key)
      .send(body);
    expect(response.status).toBe(400);
    expect(spies.adjust).not.toHaveBeenCalled();
  });

  it.each([
    ['lowStock', '/api/v1/staff/operations/inventory-low-stock?pageSize=0'],
    ['reconciliation', '/api/v1/staff/operations/inventory-reconciliation?pageSize=101'],
    ['listTransfers', '/api/v1/staff/operations/inventory-transfers?paymentStatus=paid'],
  ] as const)('rejects invalid %s query before read delegation', async (name, path) => {
    const response = await request(app.getHttpServer())
      .get(path)
      .set('origin', httpProfile.WEB_ORIGIN)
      .set('cookie', `${SESSION_COOKIE_NAME}=${sid}`);
    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(spies[name]).not.toHaveBeenCalled();
  });

  it('returns typed problem details for service conflicts and preserves currentVersion', async () => {
    spies.adjust.mockRejectedValueOnce(
      new InventoryOperationConflict('stale', 'INVENTORY_REVISION_CONFLICT', 7),
    );
    const response = await send(routes[0]);
    expect(response.status).toBe(409);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      code: 'INVENTORY_REVISION_CONFLICT',
      currentVersion: 7,
      requestId: expect.any(String),
    });
  });

  it('maps mocked not-found and in-progress service failures to problem details', async () => {
    spies.getTransfer.mockRejectedValueOnce(new NotFoundException('missing'));
    const missing = await send(routes[7]);
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(missing.headers['cache-control']).toBe('no-store');
    spies.adjust.mockRejectedValueOnce(
      new InventoryOperationConflict('busy', 'INVENTORY_COMMAND_IN_PROGRESS'),
    );
    const busy = await send(routes[0]);
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ code: 'INVENTORY_COMMAND_IN_PROGRESS' });
    expect(busy.headers['content-type']).toContain('application/problem+json');
    expect(busy.headers['cache-control']).toBe('no-store');
  });

  it('publishes concrete inventory response schemas and 201 create', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs/openapi.json');
    expect(response.status).toBe(200);
    const paths = response.body.paths as Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;
    for (const path of [
      '/api/v1/staff/inventory/balances/{id}/adjustments',
      '/api/v1/staff/inventory/balances/{id}/thresholds',
      '/api/v1/staff/inventory/transfers',
      '/api/v1/staff/inventory/transfers/{id}/transitions',
      '/api/v1/staff/operations/inventory-low-stock',
      '/api/v1/staff/operations/inventory-reconciliation',
      '/api/v1/staff/operations/inventory-transfers',
      '/api/v1/staff/operations/inventory-transfers/{id}',
    ])
      expect(paths[path]).toBeDefined();
    expect(paths['/api/v1/staff/inventory/transfers'].post.responses['201']).toBeDefined();
    expect(paths['/api/v1/staff/inventory/transfers'].post.responses['200']).toBeUndefined();
    const schemas = response.body.components.schemas;
    expect(schemas.InventoryTransferCommandResponseDto.properties.transferId).toBeUndefined();
    expect(schemas.InventoryBalanceAdjustmentResponseDto.properties.warehouseId).toBeUndefined();
    expect(schemas.InventoryTransferResponseDto.properties.etag).toBeUndefined();
    expect(schemas.InventoryLowStockPageDto.properties.items).toBeDefined();
    expect(schemas.InventoryTransferResponseDto.properties.lines).toBeDefined();
    expect(schemas.InventoryReconciliationPageDto.properties.items).toBeDefined();
    expect(schemas.InventoryReconciliationItemDto.properties.transfer).toBeDefined();
    expect(schemas.InventoryTransferLineResponseDto.properties.received.type).toBe('number');
    for (const [path, statuses] of Object.entries({
      '/api/v1/staff/inventory/balances/{id}/adjustments': [400, 401, 403, 404, 409, 428],
      '/api/v1/staff/inventory/balances/{id}/thresholds': [400, 401, 403, 404, 409, 428],
      '/api/v1/staff/inventory/transfers': [400, 401, 403, 404, 409],
      '/api/v1/staff/inventory/transfers/{id}/transitions': [400, 401, 403, 404, 409, 428],
      '/api/v1/staff/operations/inventory-low-stock': [400, 401, 403],
      '/api/v1/staff/operations/inventory-reconciliation': [400, 401, 403],
      '/api/v1/staff/operations/inventory-transfers': [400, 401, 403],
      '/api/v1/staff/operations/inventory-transfers/{id}': [400, 401, 403, 404],
    } as Record<string, number[]>)) {
      const operation = Object.values(paths[path])[0] as {
        responses: Record<
          string,
          { content?: Record<string, unknown>; headers?: Record<string, unknown> }
        >;
      };
      for (const status of statuses) {
        const error = operation.responses[String(status)];
        expect(error?.content?.['application/problem+json']).toBeDefined();
        expect(error?.headers?.['Cache-Control']).toBeDefined();
      }
    }
    for (const path of [
      '/api/v1/staff/inventory/balances/{id}/adjustments',
      '/api/v1/staff/inventory/balances/{id}/thresholds',
      '/api/v1/staff/inventory/transfers',
      '/api/v1/staff/inventory/transfers/{id}/transitions',
    ]) {
      const operation = Object.values(paths[path])[0] as {
        responses: Record<string, { headers?: Record<string, unknown> }>;
      };
      expect(
        operation.responses['200']?.headers?.ETag ?? operation.responses['201']?.headers?.ETag,
      ).toBeDefined();
    }
  });
});
