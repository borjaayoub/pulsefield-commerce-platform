import { PrismaService } from '../database/prisma.service';
import { AuditActorType } from '../generated/prisma/enums';
import type { AuditedCommandContext } from './command-context';
import { AuditService } from './audit.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('AuditService database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const service = new AuditService();

  function context(): AuditedCommandContext {
    return {
      requestId: 'request-audit-integration',
      correlationId: 'correlation-audit-integration',
      idempotencyKey: 'idempotency-audit-integration',
      reason: 'Verify append-only audit persistence.',
      actor: {
        type: 'staff',
        id: 'administrator-integration',
        roles: ['ADMINISTRATOR'],
      },
    };
  }

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditRecord"');
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditRecord"');
    await prisma.$disconnect();
  });

  it('persists the complete safe command context and state metadata', async () => {
    await service.append(
      prisma,
      {
        action: 'configuration.foundation.activated',
        targetType: 'foundation-setting',
        targetId: 'foundation.profile',
        beforeMetadata: { activeVersion: 1 },
        afterMetadata: { activeVersion: 3, sourceRevisionVersion: 2 },
      },
      context(),
    );

    await expect(prisma.auditRecord.findFirstOrThrow()).resolves.toMatchObject({
      schemaVersion: 1,
      actorType: AuditActorType.STAFF,
      actorId: 'administrator-integration',
      actorRoles: ['ADMINISTRATOR'],
      action: 'configuration.foundation.activated',
      targetType: 'foundation-setting',
      targetId: 'foundation.profile',
      requestId: 'request-audit-integration',
      correlationId: 'correlation-audit-integration',
      idempotencyKey: 'idempotency-audit-integration',
      reason: 'Verify append-only audit persistence.',
      beforeMetadata: { activeVersion: 1 },
      afterMetadata: { activeVersion: 3, sourceRevisionVersion: 2 },
    });
  });

  it('rejects ordinary audit updates and deletes in PostgreSQL', async () => {
    await service.append(
      prisma,
      {
        action: 'configuration.foundation.activated',
        targetType: 'foundation-setting',
        targetId: 'foundation.profile',
      },
      context(),
    );
    const record = await prisma.auditRecord.findFirstOrThrow();

    await expect(
      prisma.auditRecord.update({
        where: { id: record.id },
        data: { reason: 'Rewrite history.' },
      }),
    ).rejects.toThrow();
    await expect(prisma.auditRecord.delete({ where: { id: record.id } })).rejects.toThrow();
    await expect(prisma.auditRecord.count()).resolves.toBe(1);
  });
});
