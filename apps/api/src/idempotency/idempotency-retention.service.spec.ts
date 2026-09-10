import type { AuditedCommandContext } from '../audit/command-context';
import type { AuditService } from '../audit/audit.service';
import { IdempotencyStatus } from '../generated/prisma/enums';
import { IdempotencyRetentionConflictError } from './idempotency.errors';
import {
  IDEMPOTENCY_RETENTION_BATCH_SIZE,
  IdempotencyRetentionService,
} from './idempotency-retention.service';

describe('IdempotencyRetentionService', () => {
  function context(): AuditedCommandContext {
    return {
      requestId: 'request-idempotency-retention-123',
      correlationId: 'correlation-idempotency-retention-123',
      idempotencyKey: 'idempotency-retention-123',
      actor: {
        type: 'system',
        id: 'idempotency-retention-scheduler',
        roles: ['IDEMPOTENCY_RETENTION'],
      },
      reason: 'Apply the idempotency record retention policy.',
    };
  }

  function subject() {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const findMany = jest.fn().mockResolvedValue([]);
    const deleteMany = jest.fn();
    const transaction = {
      $queryRaw: queryRaw,
      idempotencyRecord: { findMany, deleteMany },
      auditRecord: { create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(transaction)) } as never;
    const append = jest.fn().mockResolvedValue(undefined);
    return {
      service: new IdempotencyRetentionService(prisma, { append } as unknown as AuditService),
      queryRaw,
      findMany,
      deleteMany,
      append,
      transaction,
    };
  }

  it('deletes one bounded oldest batch and appends minimal evidence', async () => {
    const { service, findMany, deleteMany, append, transaction } = subject();
    findMany.mockResolvedValueOnce([{ id: 'old-1' }, { id: 'old-2' }]);
    deleteMany.mockResolvedValueOnce({ count: 2 });

    await expect(service.purgeExpired(2, context())).resolves.toBe(2);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: 2,
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ AND: expect.any(Array) }) }),
    );
    expect(append).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        action: 'idempotency.retention.executed',
        afterMetadata: { deletedCount: 2, batchSize: 2 },
      }),
      context(),
    );
  });

  it('does nothing when no record is eligible', async () => {
    const { service, deleteMany, append } = subject();

    await expect(service.purgeExpired(1, context())).resolves.toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('rolls back when a selected record became ineligible before deletion', async () => {
    const { service, findMany, deleteMany, append } = subject();
    findMany.mockResolvedValueOnce([{ id: 'old-1' }]);
    deleteMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.purgeExpired(1, context())).rejects.toThrow(
      IdempotencyRetentionConflictError,
    );
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects untrusted actors and unsafe batches', async () => {
    const { service } = subject();
    await expect(
      service.purgeExpired(1, { ...context(), actor: { type: 'system', id: 'other', roles: [] } }),
    ).rejects.toThrow(IdempotencyRetentionConflictError);
    await expect(
      service.purgeExpired(IDEMPOTENCY_RETENTION_BATCH_SIZE + 1, context()),
    ).rejects.toThrow(IdempotencyRetentionConflictError);
  });

  it('keeps the live-claim eligibility branch distinct from terminal records', async () => {
    const { service, findMany } = subject();

    await service.purgeExpired(1, context());

    const where = findMany.mock.calls[0]?.[0].where as {
      OR: Array<{ status: unknown; lockedUntil?: unknown }>;
    };
    expect(where.OR).toEqual([
      { status: { in: [IdempotencyStatus.COMPLETED, IdempotencyStatus.FAILED_RETRYABLE] } },
      {
        status: IdempotencyStatus.IN_PROGRESS,
        lockedUntil: expect.objectContaining({ lt: expect.any(Date) }),
      },
    ]);
  });
});
