import { PrismaService } from '../database/prisma.service';
import { AuditActorType } from '../generated/prisma/enums';
import { randomUUID } from 'node:crypto';
import { AuditRetentionHeldError } from './audit.errors';
import { AuditQueryService, type AuditExportContext } from './audit-query.service';
import {
  AUDIT_RETENTION_DAYS,
  AuditRetentionService,
  type AuditAdministratorContext,
} from './audit-retention.service';
import { AuditService } from './audit.service';
import type { AuditedCommandContext } from './command-context';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('Audit governance database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const audit = new AuditService();
  const query = new AuditQueryService(prisma, audit);
  const retention = new AuditRetentionService(prisma, audit);

  function readerContext() {
    return {
      actor: { type: 'staff' as const, id: 'administrator-integration', roles: ['ADMINISTRATOR'] },
      authenticationAssurance: 'PASSWORD_MFA' as const,
      authenticatedAt: new Date(),
    };
  }

  function administratorContext(reason: string): AuditAdministratorContext {
    return {
      ...readerContext(),
      requestId: `request-${randomUUID()}`,
      correlationId: `correlation-${randomUUID()}`,
      idempotencyKey: `idempotency-${randomUUID()}`,
      reason,
    };
  }

  function exportContext(): AuditExportContext {
    return administratorContext('Export audit history for an authorized investigation.');
  }

  function systemContext(): AuditedCommandContext {
    return {
      requestId: `request-${randomUUID()}`,
      correlationId: `correlation-${randomUUID()}`,
      idempotencyKey: `idempotency-${randomUUID()}`,
      reason: 'Apply the documented local audit retention policy.',
      actor: {
        type: 'system',
        id: 'audit-retention-worker',
        roles: ['AUDIT_RETENTION'],
      },
    };
  }

  async function createRecord(
    id: string,
    occurredAt: Date,
    overrides: {
      actorId?: string;
      targetId?: string;
      reason?: string;
      beforeMetadata?: object;
    } = {},
  ) {
    return prisma.auditRecord.create({
      data: {
        id,
        schemaVersion: 1,
        actorType: AuditActorType.STAFF,
        actorId: overrides.actorId ?? 'administrator-sensitive-1234',
        actorRoles: ['ADMINISTRATOR'],
        action: 'configuration.foundation.activated',
        targetType: 'foundation-setting',
        targetId: overrides.targetId ?? 'foundation.profile',
        requestId: `request-${id}`,
        correlationId: `correlation-${id}`,
        idempotencyKey: `idempotency-${id}`,
        reason: overrides.reason ?? 'Activate a reviewed revision.',
        beforeMetadata: overrides.beforeMetadata,
        afterMetadata: { activeVersion: 2 },
        occurredAt,
      },
    });
  }

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditRecord", "AuditRetentionHold"');
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditRecord", "AuditRetentionHold"');
    await prisma.$disconnect();
  });

  it('uses stable keyset pagination and masks stored direct identifiers defensively', async () => {
    const occurredAt = new Date('2026-09-03T15:00:00.000Z');
    const firstId = 'f62d69e7-0c86-4df8-b592-577815cb8461';
    const secondId = '6d6eb274-3885-474d-b3c3-09845a1d0f3f';
    await createRecord(firstId, occurredAt, {
      reason: 'Legacy contact person@example.test has account 4111111111111111.',
      beforeMetadata: { customerEmail: 'person@example.test', activeVersion: 1 },
    });
    await createRecord(secondId, occurredAt);

    const firstPage = await query.list({ limit: 1 }, readerContext());
    const secondPage = await query.list(
      { limit: 1, cursor: firstPage.nextCursor ?? undefined },
      readerContext(),
    );

    expect(firstPage.records.map(({ id }) => id)).toEqual([firstId]);
    expect(secondPage.records.map(({ id }) => id)).toEqual([secondId]);
    expect(firstPage.records[0]).toMatchObject({
      actor: { id: '***1234' },
      target: { id: '***file' },
      reason: 'Legacy contact [REDACTED_EMAIL] has account [REDACTED_NUMBER].',
      beforeMetadata: { customerEmail: '[REDACTED]', activeVersion: 1 },
    });
  });

  it('records a bounded export without placing exported data in its audit event', async () => {
    await createRecord(
      'f62d69e7-0c86-4df8-b592-577815cb8461',
      new Date('2026-09-03T15:00:00.000Z'),
    );

    const exported = await query.export({ actorType: AuditActorType.STAFF }, exportContext());

    expect(exported.records).toHaveLength(1);
    const evidence = await prisma.auditRecord.findFirstOrThrow({
      where: { action: 'audit.history.exported' },
    });
    expect(evidence.afterMetadata).toEqual({ recordCount: 1, filterCount: 1, hasMore: false });
    expect(JSON.stringify(evidence)).not.toContain('administrator-sensitive-1234');
  });

  it('purges only records older than the fixed retention period and retains purge evidence', async () => {
    const oldId = 'f62d69e7-0c86-4df8-b592-577815cb8461';
    const recentId = '6d6eb274-3885-474d-b3c3-09845a1d0f3f';
    await createRecord(oldId, new Date(Date.now() - (AUDIT_RETENTION_DAYS + 1) * 86_400_000));
    await createRecord(recentId, new Date(Date.now() - (AUDIT_RETENTION_DAYS - 1) * 86_400_000));

    await expect(retention.purgeExpired(1, systemContext())).resolves.toBe(1);

    await expect(prisma.auditRecord.findUnique({ where: { id: oldId } })).resolves.toBeNull();
    await expect(
      prisma.auditRecord.findUnique({ where: { id: recentId } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.auditRecord.findFirst({ where: { action: 'audit.retention.executed' } }),
    ).resolves.toMatchObject({
      actorType: AuditActorType.SYSTEM,
      afterMetadata: { deletedCount: 1, retentionDays: AUDIT_RETENTION_DAYS },
    });
  });

  it('blocks retention during a hold and allows it only after one audited release', async () => {
    const oldId = 'f62d69e7-0c86-4df8-b592-577815cb8461';
    await createRecord(oldId, new Date(Date.now() - (AUDIT_RETENTION_DAYS + 1) * 86_400_000));
    const hold = await retention.createHold(
      new Date(Date.now() + 60 * 60_000),
      administratorContext('Preserve evidence during an active investigation.'),
    );

    await expect(retention.purgeExpired(100, systemContext())).rejects.toThrow(
      AuditRetentionHeldError,
    );
    await expect(prisma.auditRecord.findUnique({ where: { id: oldId } })).resolves.not.toBeNull();

    await retention.releaseHold(
      hold.id,
      administratorContext('Release the completed investigation hold.'),
    );
    await expect(retention.purgeExpired(100, systemContext())).resolves.toBe(1);
    await expect(
      retention.releaseHold(
        hold.id,
        administratorContext('Attempt a second release of the same hold.'),
      ),
    ).rejects.toThrow();
    await expect(
      prisma.auditRecord.count({
        where: {
          action: { in: ['audit.retention-hold.created', 'audit.retention-hold.released'] },
        },
      }),
    ).resolves.toBe(2);
  });

  it('keeps direct mutations and retention of recent records blocked in PostgreSQL', async () => {
    const id = 'f62d69e7-0c86-4df8-b592-577815cb8461';
    await createRecord(id, new Date());

    await expect(
      prisma.auditRecord.update({ where: { id }, data: { reason: 'Rewrite history.' } }),
    ).rejects.toThrow();
    await expect(prisma.auditRecord.delete({ where: { id } })).rejects.toThrow();
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT set_config('pulse_field.audit_retention', 'enabled', true)`;
        await transaction.auditRecord.delete({ where: { id } });
      }),
    ).rejects.toThrow();
    await expect(prisma.auditRecord.findUnique({ where: { id } })).resolves.not.toBeNull();
  });
});
