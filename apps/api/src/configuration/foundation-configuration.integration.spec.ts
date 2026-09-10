import { AuditService } from '../audit/audit.service';
import type { AuditedCommandContext } from '../audit/command-context';
import { PrismaService } from '../database/prisma.service';
import { FoundationSettingLifecycle, OutboxMessageStatus } from '../generated/prisma/enums';
import {
  FOUNDATION_CONFIGURATION_ACTIVATED_EVENT_TYPE,
  FOUNDATION_PROFILE_KEY,
  FoundationConfigurationService,
} from './foundation-configuration.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('FoundationConfigurationService database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const audit = new AuditService();
  const service = new FoundationConfigurationService(prisma, audit);
  const initialValue = {
    profile: 'zero-cost-local',
    status: 'phase-1-ready',
    paymentProvider: 'stub',
    smtpProvider: 'mailpit',
  };
  const changedValue = { ...initialValue, status: 'phase-2-ready' };

  function context(actorId: string): AuditedCommandContext {
    return {
      requestId: 'request-integration-config',
      correlationId: `correlation-${actorId}`,
      idempotencyKey: `idempotency-${actorId}`,
      reason: 'Verify the configuration audit foundation.',
      actor: { type: 'staff', id: actorId, roles: ['ADMINISTRATOR'] },
    };
  }

  async function resetFoundationSetting(): Promise<void> {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditRecord"');
    await prisma.outboxMessage.deleteMany({
      where: {
        eventType: FOUNDATION_CONFIGURATION_ACTIVATED_EVENT_TYPE,
        aggregateId: FOUNDATION_PROFILE_KEY,
      },
    });
    await prisma.foundationSettingRevision.deleteMany({
      where: { settingKey: FOUNDATION_PROFILE_KEY },
    });
    await prisma.foundationSetting.deleteMany({ where: { key: FOUNDATION_PROFILE_KEY } });
    await prisma.foundationSetting.create({
      data: {
        key: FOUNDATION_PROFILE_KEY,
        value: initialValue,
        version: 1,
        latestRevision: 1,
        revisions: {
          create: {
            version: 1,
            value: initialValue,
            lifecycle: FoundationSettingLifecycle.ACTIVE,
            validationResult: { valid: true, issues: [] },
            authoredBy: 'system:integration-seed',
            approvedBy: 'system:integration-seed',
            activatedBy: 'system:integration-seed',
            effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
          },
        },
      },
    });
  }

  beforeEach(resetFoundationSetting);
  afterAll(async () => {
    await resetFoundationSetting();
    await prisma.$disconnect();
  });

  it('allows exactly one concurrent draft to allocate the expected next version', async () => {
    const results = await Promise.allSettled([
      service.createDraft(
        {
          key: FOUNDATION_PROFILE_KEY,
          value: changedValue,
          expectedLatestRevision: 1,
        },
        context('administrator-a'),
      ),
      service.createDraft(
        {
          key: FOUNDATION_PROFILE_KEY,
          value: changedValue,
          expectedLatestRevision: 1,
        },
        context('administrator-b'),
      ),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    await expect(
      prisma.foundationSettingRevision.count({
        where: { settingKey: FOUNDATION_PROFILE_KEY, version: 2 },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.foundationSetting.findUniqueOrThrow({ where: { key: FOUNDATION_PROFILE_KEY } }),
    ).resolves.toMatchObject({ version: 1, latestRevision: 2, value: initialValue });
    await expect(
      prisma.auditRecord.count({
        where: { action: 'configuration.foundation.draft-created' },
      }),
    ).resolves.toBe(1);
  });

  it('preserves approval history and atomically activates a new version', async () => {
    const draft = await service.createDraft(
      { key: FOUNDATION_PROFILE_KEY, value: changedValue, expectedLatestRevision: 1 },
      context('administrator-author'),
    );
    const approved = await service.approveDraft(
      {
        key: FOUNDATION_PROFILE_KEY,
        revisionVersion: draft.version,
        expectedLockVersion: draft.lockVersion,
      },
      context('administrator-approver'),
    );
    const active = await service.activateApproved(
      {
        key: FOUNDATION_PROFILE_KEY,
        revisionVersion: approved.version,
        expectedLatestRevision: 2,
      },
      {
        ...context('administrator-activator'),
        correlationId: 'integration-config-activation',
      },
    );

    expect(active).toMatchObject({
      version: 3,
      lifecycle: FoundationSettingLifecycle.ACTIVE,
      sourceRevisionVersion: 2,
    });
    const revisions = await prisma.foundationSettingRevision.findMany({
      where: { settingKey: FOUNDATION_PROFILE_KEY },
      orderBy: { version: 'asc' },
    });
    expect(revisions.map(({ lifecycle }) => lifecycle)).toEqual([
      FoundationSettingLifecycle.RETIRED,
      FoundationSettingLifecycle.APPROVED,
      FoundationSettingLifecycle.ACTIVE,
    ]);
    expect(revisions[0]?.value).toEqual(initialValue);
    expect(revisions[1]?.value).toEqual(changedValue);
    expect(revisions[2]?.value).toEqual(changedValue);
    await expect(service.current()).resolves.toMatchObject({
      version: 3,
      latestRevision: 3,
      value: changedValue,
    });
    await expect(
      prisma.outboxMessage.findFirstOrThrow({
        where: { correlationId: 'integration-config-activation' },
      }),
    ).resolves.toMatchObject({
      eventType: FOUNDATION_CONFIGURATION_ACTIVATED_EVENT_TYPE,
      status: OutboxMessageStatus.PENDING,
      payload: {
        key: FOUNDATION_PROFILE_KEY,
        activeVersion: 3,
        sourceRevisionVersion: 2,
      },
    });
    const auditActions = await prisma.auditRecord.findMany({
      where: { targetId: FOUNDATION_PROFILE_KEY },
      select: { action: true },
    });
    expect(auditActions).toHaveLength(3);
    expect(auditActions).toEqual(
      expect.arrayContaining([
        { action: 'configuration.foundation.draft-created' },
        { action: 'configuration.foundation.draft-approved' },
        { action: 'configuration.foundation.activated' },
      ]),
    );
  });

  it('rolls back by copying an old valid snapshot into a new active version', async () => {
    const draft = await service.createDraft(
      { key: FOUNDATION_PROFILE_KEY, value: changedValue, expectedLatestRevision: 1 },
      context('administrator-author'),
    );
    await service.approveDraft(
      {
        key: FOUNDATION_PROFILE_KEY,
        revisionVersion: draft.version,
        expectedLockVersion: draft.lockVersion,
      },
      context('administrator-approver'),
    );
    await service.activateApproved(
      { key: FOUNDATION_PROFILE_KEY, revisionVersion: 2, expectedLatestRevision: 2 },
      context('administrator-activator'),
    );

    const rolledBack = await service.rollback(
      { key: FOUNDATION_PROFILE_KEY, sourceRevisionVersion: 1, expectedLatestRevision: 3 },
      context('administrator-rollback'),
    );

    expect(rolledBack).toMatchObject({
      version: 4,
      value: initialValue,
      lifecycle: FoundationSettingLifecycle.ACTIVE,
      sourceRevisionVersion: 1,
      authoredBy: 'administrator-rollback',
    });
    await expect(service.current()).resolves.toMatchObject({
      version: 4,
      latestRevision: 4,
      value: initialValue,
    });
    await expect(
      prisma.auditRecord.count({
        where: { action: 'configuration.foundation.rolled-back' },
      }),
    ).resolves.toBe(1);
  });

  it('rejects rollback from the current active revision', async () => {
    await expect(
      service.rollback(
        { key: FOUNDATION_PROFILE_KEY, sourceRevisionVersion: 1, expectedLatestRevision: 1 },
        context('administrator-rollback'),
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_TRANSITION_INVALID' });
    await expect(service.current()).resolves.toMatchObject({
      version: 1,
      latestRevision: 1,
      value: initialValue,
    });
  });

  it('enforces immutable revision payloads in PostgreSQL', async () => {
    await expect(
      prisma.foundationSettingRevision.update({
        where: {
          settingKey_version: { settingKey: FOUNDATION_PROFILE_KEY, version: 1 },
        },
        data: { value: changedValue, lockVersion: { increment: 1 } },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.foundationSettingRevision.findUniqueOrThrow({
        where: {
          settingKey_version: { settingKey: FOUNDATION_PROFILE_KEY, version: 1 },
        },
      }),
    ).resolves.toMatchObject({ value: initialValue });
  });

  it('rolls back the protected mutation when audit persistence fails', async () => {
    const draft = await service.createDraft(
      { key: FOUNDATION_PROFILE_KEY, value: changedValue, expectedLatestRevision: 1 },
      context('administrator-author'),
    );
    await service.approveDraft(
      {
        key: FOUNDATION_PROFILE_KEY,
        revisionVersion: draft.version,
        expectedLockVersion: draft.lockVersion,
      },
      context('administrator-approver'),
    );

    const failingAudit = {
      append: async () => {
        throw new Error('AUDIT_INSERT_FAILED');
      },
    } as AuditService;
    const serviceWithFailingAudit = new FoundationConfigurationService(prisma, failingAudit);

    await expect(
      serviceWithFailingAudit.activateApproved(
        { key: FOUNDATION_PROFILE_KEY, revisionVersion: 2, expectedLatestRevision: 2 },
        context('administrator-activator'),
      ),
    ).rejects.toThrow('AUDIT_INSERT_FAILED');
    await expect(service.current()).resolves.toMatchObject({
      version: 1,
      latestRevision: 2,
      value: initialValue,
    });
    await expect(
      prisma.foundationSettingRevision.findUniqueOrThrow({
        where: {
          settingKey_version: { settingKey: FOUNDATION_PROFILE_KEY, version: 1 },
        },
      }),
    ).resolves.toMatchObject({ lifecycle: FoundationSettingLifecycle.ACTIVE });
    await expect(
      prisma.foundationSettingRevision.count({
        where: { settingKey: FOUNDATION_PROFILE_KEY, version: 3 },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.auditRecord.count({
        where: { action: 'configuration.foundation.activated' },
      }),
    ).resolves.toBe(0);
  });
});
