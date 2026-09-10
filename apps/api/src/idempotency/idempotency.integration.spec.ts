import type { CommandContext } from '@pulse-field/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { IdempotencyStatus } from '../generated/prisma/enums';
import { IdempotencyClaimLostError, IdempotencyConflictError } from './idempotency.errors';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyRetentionService } from './idempotency-retention.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('IdempotencyService database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const service = new IdempotencyService(prisma);
  const retention = new IdempotencyRetentionService(prisma, new AuditService());

  function context(key: string): CommandContext {
    return {
      idempotencyKey: key,
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      actor: {
        type: 'customer',
        id: 'customer-idempotency-integration',
        roles: ['CUSTOMER'],
      },
    };
  }

  function retentionContext(): CommandContext & { reason: string } {
    const id = randomUUID();
    return {
      idempotencyKey: `idempotency-retention-${id}`,
      requestId: `request-idempotency-retention-${id}`,
      correlationId: `correlation-idempotency-retention-${id}`,
      actor: {
        type: 'system',
        id: 'idempotency-retention-scheduler',
        roles: ['IDEMPOTENCY_RETENTION'],
      },
      reason: 'Apply the idempotency record retention policy.',
    };
  }

  beforeEach(async () => {
    await prisma.idempotencyRecord.deleteMany();
  });

  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany();
    await prisma.$disconnect();
  });

  it('allows only one concurrent owner and persists no raw key or request input', async () => {
    const commandContext = context('idempotency-concurrent-123456');
    const request = { cartId: 'private-cart-123', expectedVersion: 2 };

    const results = await Promise.all([
      service.begin({ operation: 'checkout.create', request }, commandContext),
      service.begin({ operation: 'checkout.create', request }, commandContext),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(['acquired', 'in-progress']);
    const record = await prisma.idempotencyRecord.findFirstOrThrow();
    expect(record.status).toBe(IdempotencyStatus.IN_PROGRESS);
    expect(record.attemptCount).toBe(1);
    expect(record.keyDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.claimTokenDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(record)).not.toContain(commandContext.idempotencyKey);
    expect(JSON.stringify(record)).not.toContain(request.cartId);
  });

  it('rejects the same key when the command input differs', async () => {
    const commandContext = context('idempotency-conflict-123456');
    await service.begin(
      { operation: 'inventory.reserve', request: { sku: 'shoe-blue-42', quantity: 1 } },
      commandContext,
    );

    await expect(
      service.begin(
        { operation: 'inventory.reserve', request: { sku: 'shoe-blue-42', quantity: 2 } },
        commandContext,
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('reclaims a retryable failure and prevents the old owner from completing it', async () => {
    const commandContext = context('idempotency-retryable-123456');
    const input = { operation: 'inventory.commit', request: { reservationId: 'reservation-123' } };
    const first = await service.begin(input, commandContext);
    if (first.kind !== 'acquired')
      throw new Error('Expected the first owner to acquire the command.');

    await service.fail(first.claim, 'TEMPORARY_DATABASE_FAILURE');
    const second = await service.begin(input, commandContext);
    expect(second).toMatchObject({ kind: 'acquired', attemptCount: 2 });

    await expect(
      service.complete(prisma, first.claim, {
        type: 'reservation',
        id: 'reservation-123',
        responseStatus: 200,
      }),
    ).rejects.toThrow(IdempotencyClaimLostError);
  });

  it('reclaims an expired lease and rejects completion by the replaced token', async () => {
    const commandContext = context('idempotency-stale-123456');
    const input = { operation: 'refund.create', request: { paymentId: 'payment-123' } };
    const first = await service.begin(input, commandContext);
    if (first.kind !== 'acquired')
      throw new Error('Expected the first owner to acquire the command.');
    await prisma.idempotencyRecord.update({
      where: { id: first.claim.recordId },
      data: { lockedUntil: new Date(Date.now() - 1_000) },
    });

    const second = await service.begin(input, commandContext);

    expect(second).toMatchObject({ kind: 'acquired', attemptCount: 2 });
    await expect(
      service.complete(prisma, first.claim, {
        type: 'refund',
        id: 'refund-123',
        responseStatus: 201,
      }),
    ).rejects.toThrow(IdempotencyClaimLostError);
  });

  it('commits the safe result in the business transaction and replays it', async () => {
    const commandContext = context('idempotency-complete-123456');
    const input = { operation: 'checkout.create', request: { cartId: 'cart-complete-123' } };
    const begun = await service.begin(input, commandContext);
    if (begun.kind !== 'acquired')
      throw new Error('Expected the first owner to acquire the command.');

    await prisma.$transaction(async (transaction) => {
      await service.complete(transaction, begun.claim, {
        type: 'checkout',
        id: 'checkout-123',
        responseStatus: 201,
      });
    });

    await expect(service.begin(input, commandContext)).resolves.toEqual({
      kind: 'replay',
      result: { type: 'checkout', id: 'checkout-123', responseStatus: 201 },
    });
    await expect(
      prisma.idempotencyRecord.findUniqueOrThrow({ where: { id: begun.claim.recordId } }),
    ).resolves.toMatchObject({
      status: IdempotencyStatus.COMPLETED,
      claimTokenDigest: null,
      lockedUntil: null,
      resultType: 'checkout',
      resultId: 'checkout-123',
      responseStatus: 201,
      completedAt: expect.any(Date),
    });
  });

  it('rolls completion back when the surrounding business transaction fails', async () => {
    const commandContext = context('idempotency-rollback-123456');
    const input = { operation: 'inventory.release', request: { reservationId: 'reservation-456' } };
    const begun = await service.begin(input, commandContext);
    if (begun.kind !== 'acquired')
      throw new Error('Expected the first owner to acquire the command.');

    await expect(
      prisma.$transaction(async (transaction) => {
        await service.complete(transaction, begun.claim, {
          type: 'reservation',
          id: 'reservation-456',
          responseStatus: 200,
        });
        throw new Error('Rollback the business mutation.');
      }),
    ).rejects.toThrow('Rollback the business mutation.');

    await expect(
      prisma.idempotencyRecord.findUniqueOrThrow({ where: { id: begun.claim.recordId } }),
    ).resolves.toMatchObject({
      status: IdempotencyStatus.IN_PROGRESS,
      resultType: null,
      resultId: null,
      completedAt: null,
    });
  });

  it('purges only expired terminal or abandoned records and audits the batch', async () => {
    const now = new Date();
    const expired = new Date(now.getTime() - 1_000);
    const future = new Date(now.getTime() + 60_000);
    const createdAt = new Date(now.getTime() - 2_000);
    const create = (suffix: string, status: IdempotencyStatus, lockedUntil: Date | null) =>
      prisma.idempotencyRecord.create({
        data: {
          actorType: 'SYSTEM',
          actorId: `retention-${suffix}`,
          operation: 'retention.test',
          keyDigest: createHash('sha256').update(`key-${suffix}`).digest('hex'),
          requestFingerprint: createHash('sha256').update(`request-${suffix}`).digest('hex'),
          status,
          claimTokenDigest: status === IdempotencyStatus.IN_PROGRESS ? 'a'.repeat(64) : null,
          lockedUntil,
          resultType: status === IdempotencyStatus.COMPLETED ? 'retention-test' : null,
          resultId: status === IdempotencyStatus.COMPLETED ? `result-${suffix}` : null,
          responseStatus: status === IdempotencyStatus.COMPLETED ? 204 : null,
          completedAt: status === IdempotencyStatus.COMPLETED ? createdAt : null,
          lastErrorCode: status === IdempotencyStatus.FAILED_RETRYABLE ? 'RETRYABLE_TEST' : null,
          createdAt,
          expiresAt:
            status === IdempotencyStatus.COMPLETED && suffix === 'fresh' ? future : expired,
        },
      });
    const completed = await create('completed', IdempotencyStatus.COMPLETED, null);
    const retryable = await create('retryable', IdempotencyStatus.FAILED_RETRYABLE, null);
    const abandoned = await create(
      'abandoned',
      IdempotencyStatus.IN_PROGRESS,
      new Date(now.getTime() - 1_000),
    );
    const live = await create('live', IdempotencyStatus.IN_PROGRESS, future);
    const fresh = await create('fresh', IdempotencyStatus.COMPLETED, null);
    const command = retentionContext();

    await expect(retention.purgeExpired(10, command)).resolves.toBe(3);
    await expect(
      prisma.idempotencyRecord.findMany({
        where: { id: { in: [completed.id, retryable.id, abandoned.id] } },
      }),
    ).resolves.toEqual([]);
    await expect(
      prisma.idempotencyRecord.findMany({ where: { id: { in: [live.id, fresh.id] } } }),
    ).resolves.toHaveLength(2);
    await expect(
      prisma.auditRecord.count({
        where: {
          action: 'idempotency.retention.executed',
          requestId: command.requestId,
        },
      }),
    ).resolves.toBe(1);
  });
});
