import { PrismaService } from '../database/prisma.service';
import type { AuditRecord } from '../generated/prisma/client';
import { AuditActorType } from '../generated/prisma/enums';
import { AuditAccessDeniedError, InvalidAuditQueryError } from './audit.errors';
import { AuditQueryService, type AuditExportContext } from './audit-query.service';
import type { AuditService } from './audit.service';

describe('AuditQueryService', () => {
  const occurredAt = new Date('2026-09-03T15:00:00.000Z');
  const record: AuditRecord = {
    id: 'f62d69e7-0c86-4df8-b592-577815cb8461',
    schemaVersion: 1,
    actorType: AuditActorType.STAFF,
    actorId: 'administrator-123456',
    actorRoles: ['ADMINISTRATOR'],
    action: 'configuration.foundation.activated',
    targetType: 'foundation-setting',
    targetId: 'foundation.profile',
    requestId: 'request-audit-query-123',
    correlationId: 'correlation-audit-query-123',
    causationId: null,
    idempotencyKey: 'idempotency-audit-query-123',
    reason: 'Reviewed by person@example.test for account 4111111111111111.',
    beforeMetadata: { customerEmail: 'person@example.test', version: 1 },
    afterMetadata: { status: 'ACTIVE' },
    occurredAt,
  };

  function readerContext() {
    return {
      actor: { type: 'staff' as const, id: 'administrator-1', roles: ['ADMINISTRATOR'] },
      authenticationAssurance: 'PASSWORD_MFA' as const,
      authenticatedAt: new Date(),
    };
  }

  function exportContext(): AuditExportContext {
    return {
      ...readerContext(),
      requestId: 'request-audit-export-123',
      correlationId: 'correlation-audit-export-123',
      idempotencyKey: 'idempotency-audit-export-123',
      reason: 'Export audit history for a documented investigation.',
    };
  }

  function subject(records: AuditRecord[] = [record]) {
    const findMany = jest.fn().mockResolvedValue(records);
    const append = jest.fn().mockResolvedValue(undefined);
    const transaction = { auditRecord: { findMany } };
    const prisma = {
      auditRecord: { findMany },
      $transaction: jest.fn((callback) => callback(transaction)),
    } as unknown as PrismaService;
    const audit = { append } as unknown as AuditService;
    return { service: new AuditQueryService(prisma, audit), findMany, append, transaction };
  }

  it('queries a bounded page and masks direct or suspicious values', async () => {
    const { service, findMany } = subject();

    const page = await service.list(
      { limit: 20, action: 'configuration.foundation.activated' },
      readerContext(),
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 21,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        where: expect.objectContaining({ action: 'configuration.foundation.activated' }),
      }),
    );
    expect(page.records[0]).toMatchObject({
      actor: { id: '***3456' },
      target: { id: '***file' },
      idempotencyKey: '***-123',
      reason: 'Reviewed by [REDACTED_EMAIL] for account [REDACTED_NUMBER].',
      beforeMetadata: { customerEmail: '[REDACTED]', version: 1 },
    });
  });

  it('returns a cursor from the last visible record when another row exists', async () => {
    const second = {
      ...record,
      id: '6d6eb274-3885-474d-b3c3-09845a1d0f3f',
      occurredAt: new Date(occurredAt.getTime() - 1),
    };
    const { service } = subject([record, second]);

    const page = await service.list({ limit: 1 }, readerContext());

    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('rejects unauthorized readers, oversized pages, and invalid time ranges', async () => {
    const { service, findMany } = subject();
    expect(() =>
      service.list({ limit: 1 }, { ...readerContext(), authenticationAssurance: 'PASSWORD' }),
    ).toThrow(AuditAccessDeniedError);
    await expect(service.list({ limit: 101 }, readerContext())).rejects.toThrow(
      InvalidAuditQueryError,
    );
    await expect(
      service.list(
        {
          occurredFrom: new Date('2026-09-03T16:00:00.000Z'),
          occurredTo: new Date('2026-09-03T15:00:00.000Z'),
        },
        readerContext(),
      ),
    ).rejects.toThrow(InvalidAuditQueryError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('audits a bounded export without copying exported records into its metadata', async () => {
    const { service, findMany, append, transaction } = subject();

    const page = await service.export({ actorType: AuditActorType.STAFF }, exportContext());

    expect(page.records).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1_001 }));
    expect(append).toHaveBeenCalledWith(
      transaction,
      {
        action: 'audit.history.exported',
        targetType: 'audit-history',
        targetId: 'audit-history',
        afterMetadata: { recordCount: 1, filterCount: 1, hasMore: false },
      },
      expect.objectContaining({ reason: 'Export audit history for a documented investigation.' }),
    );
    expect(JSON.stringify(append.mock.calls)).not.toContain('person@example.test');
  });
});
