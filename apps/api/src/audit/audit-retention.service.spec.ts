import { PrismaService } from '../database/prisma.service';
import type { AuditService } from './audit.service';
import { AuditRetentionConflictError, AuditRetentionHeldError } from './audit.errors';
import {
  AUDIT_RETENTION_DAYS,
  AuditRetentionService,
  type AuditAdministratorContext,
} from './audit-retention.service';
import type { AuditedCommandContext } from './command-context';

describe('AuditRetentionService', () => {
  function administratorContext(): AuditAdministratorContext {
    return {
      requestId: 'request-retention-admin-123',
      correlationId: 'correlation-retention-admin-123',
      idempotencyKey: 'idempotency-retention-admin-123',
      reason: 'Preserve audit history for an active investigation.',
      actor: { type: 'staff', id: 'administrator-1', roles: ['ADMINISTRATOR'] },
      authenticationAssurance: 'PASSWORD_MFA',
      authenticatedAt: new Date(),
    };
  }

  function systemContext(): AuditedCommandContext {
    return {
      requestId: 'request-retention-system-123',
      correlationId: 'correlation-retention-system-123',
      idempotencyKey: 'idempotency-retention-system-123',
      reason: 'Apply the documented audit retention policy.',
      actor: { type: 'system', id: 'audit-retention-worker', roles: ['AUDIT_RETENTION'] },
    };
  }

  function subject() {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const createHold = jest.fn();
    const updateHold = jest.fn();
    const findHold = jest.fn().mockResolvedValue(null);
    const findHoldOrThrow = jest.fn();
    const findRecords = jest.fn().mockResolvedValue([]);
    const deleteRecords = jest.fn();
    const transaction = {
      $queryRaw: queryRaw,
      auditRetentionHold: {
        create: createHold,
        updateMany: updateHold,
        findFirst: findHold,
        findUniqueOrThrow: findHoldOrThrow,
      },
      auditRecord: { findMany: findRecords, deleteMany: deleteRecords },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(transaction)),
    } as unknown as PrismaService;
    const append = jest.fn().mockResolvedValue(undefined);
    const audit = { append } as unknown as AuditService;
    return {
      service: new AuditRetentionService(prisma, audit),
      transaction,
      queryRaw,
      createHold,
      updateHold,
      findHold,
      findHoldOrThrow,
      findRecords,
      deleteRecords,
      append,
    };
  }

  it('creates a bounded investigation hold and its audit evidence atomically', async () => {
    const { service, createHold, append, transaction } = subject();
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    createHold.mockResolvedValueOnce({ id: 'hold-123', expiresAt });

    await service.createHold(expiresAt, administratorContext());

    expect(createHold).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reason: 'Preserve audit history for an active investigation.',
        createdBy: 'administrator-1',
        expiresAt,
      }),
    });
    expect(append).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'audit.retention-hold.created' }),
      expect.objectContaining({ actor: expect.objectContaining({ id: 'administrator-1' }) }),
    );
  });

  it('purges one bounded batch and leaves safe evidence', async () => {
    const { service, findRecords, deleteRecords, append, transaction } = subject();
    findRecords.mockResolvedValueOnce([{ id: 'old-1' }, { id: 'old-2' }]);
    deleteRecords.mockResolvedValueOnce({ count: 2 });

    await expect(service.purgeExpired(100, systemContext())).resolves.toBe(2);

    expect(deleteRecords).toHaveBeenCalledWith({ where: { id: { in: ['old-1', 'old-2'] } } });
    expect(append).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        action: 'audit.retention.executed',
        afterMetadata: { deletedCount: 2, retentionDays: AUDIT_RETENTION_DAYS },
      }),
      expect.any(Object),
    );
  });

  it('does not purge or append evidence when there is no expired row', async () => {
    const { service, deleteRecords, append } = subject();

    await expect(service.purgeExpired(100, systemContext())).resolves.toBe(0);

    expect(deleteRecords).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('refuses purge during an active hold', async () => {
    const { service, findHold, findRecords } = subject();
    findHold.mockResolvedValueOnce({ id: 'hold-123' });

    await expect(service.purgeExpired(100, systemContext())).rejects.toThrow(
      AuditRetentionHeldError,
    );
    expect(findRecords).not.toHaveBeenCalled();
  });

  it('rejects an untrusted purge actor and an oversized batch', async () => {
    const { service } = subject();
    await expect(
      service.purgeExpired(100, { ...systemContext(), actor: administratorContext().actor }),
    ).rejects.toThrow(AuditRetentionConflictError);
    await expect(service.purgeExpired(1_001, systemContext())).rejects.toThrow(
      AuditRetentionConflictError,
    );
  });
});
