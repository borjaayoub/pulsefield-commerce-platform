import type { AuditedCommandContext } from '../audit/command-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FoundationSettingLifecycle } from '../generated/prisma/enums';
import {
  ConfigurationConflictError,
  ConfigurationTransitionError,
  InvalidFoundationConfigurationError,
} from './configuration.errors';
import {
  FOUNDATION_CONFIGURATION_ACTIVATED_EVENT_TYPE,
  FOUNDATION_PROFILE_KEY,
  FoundationConfigurationService,
} from './foundation-configuration.service';

describe('FoundationConfigurationService', () => {
  const profile = {
    profile: 'zero-cost-local',
    status: 'phase-2-ready',
    paymentProvider: 'stub',
    smtpProvider: 'mailpit',
  };

  function context(actorId: string): AuditedCommandContext {
    return {
      requestId: 'request-configuration-1',
      correlationId: 'correlation-configuration-1',
      idempotencyKey: 'idempotency-configuration-1',
      reason: 'Maintain the local foundation profile.',
      actor: { type: 'staff', id: actorId, roles: ['ADMINISTRATOR'] },
    };
  }

  function createSubject() {
    const foundationSetting = {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    };
    const foundationSettingRevision = {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    };
    const outboxMessage = { create: jest.fn() };
    const transaction = { foundationSetting, foundationSettingRevision, outboxMessage };
    const audit = { append: jest.fn().mockResolvedValue({}) } as unknown as AuditService;
    const prisma = {
      ...transaction,
      $transaction: jest.fn(async (operation: (client: typeof transaction) => unknown) =>
        operation(transaction),
      ),
    } as unknown as PrismaService;

    return {
      service: new FoundationConfigurationService(prisma, audit),
      foundationSetting,
      foundationSettingRevision,
      outboxMessage,
      audit,
    };
  }

  it('rejects unknown or unsafe bootstrap configuration before persistence', async () => {
    const { service, foundationSetting } = createSubject();

    await expect(
      service.createDraft(
        {
          key: FOUNDATION_PROFILE_KEY,
          expectedLatestRevision: 1,
          value: { ...profile, paymentProvider: 'live-provider' },
        },
        context('administrator-1'),
      ),
    ).rejects.toBeInstanceOf(InvalidFoundationConfigurationError);
    expect(foundationSetting.updateMany).not.toHaveBeenCalled();
  });

  it('cannot be used as a generic store for future domain configuration', async () => {
    const { service, foundationSetting } = createSubject();

    await expect(
      service.createDraft(
        {
          key: 'future.price-book' as typeof FOUNDATION_PROFILE_KEY,
          expectedLatestRevision: 1,
          value: profile,
        },
        context('administrator-1'),
      ),
    ).rejects.toBeInstanceOf(InvalidFoundationConfigurationError);
    expect(foundationSetting.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a non-administrator command context', async () => {
    const { service, foundationSetting } = createSubject();
    const unauthorized = context('fulfiller-1');
    unauthorized.actor.roles = ['FULFILLER'];

    await expect(
      service.createDraft(
        { key: FOUNDATION_PROFILE_KEY, expectedLatestRevision: 1, value: profile },
        unauthorized,
      ),
    ).rejects.toBeInstanceOf(InvalidFoundationConfigurationError);
    expect(foundationSetting.updateMany).not.toHaveBeenCalled();
  });

  it('allocates one draft revision through a compare-and-swap claim', async () => {
    const { service, foundationSetting, foundationSettingRevision, audit } = createSubject();
    foundationSetting.updateMany.mockResolvedValue({ count: 1 });
    foundationSettingRevision.create.mockImplementation(({ data }) => data);

    await expect(
      service.createDraft(
        { key: FOUNDATION_PROFILE_KEY, expectedLatestRevision: 1, value: profile },
        context(' administrator-1 '),
      ),
    ).resolves.toMatchObject({
      version: 2,
      lifecycle: FoundationSettingLifecycle.DRAFT,
      authoredBy: 'administrator-1',
      validationResult: { valid: true, issues: [] },
    });
    expect(foundationSetting.updateMany).toHaveBeenCalledWith({
      where: { key: FOUNDATION_PROFILE_KEY, latestRevision: 1 },
      data: { latestRevision: 2 },
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'configuration.foundation.draft-created' }),
      expect.objectContaining({ actor: expect.objectContaining({ id: 'administrator-1' }) }),
    );
  });

  it('rejects stale draft allocation without inserting history', async () => {
    const { service, foundationSetting, foundationSettingRevision } = createSubject();
    foundationSetting.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.createDraft(
        { key: FOUNDATION_PROFILE_KEY, expectedLatestRevision: 1, value: profile },
        context('administrator-1'),
      ),
    ).rejects.toBeInstanceOf(ConfigurationConflictError);
    expect(foundationSettingRevision.create).not.toHaveBeenCalled();
  });

  it('approves only a valid draft at the expected lock version', async () => {
    const { service, foundationSettingRevision } = createSubject();
    foundationSettingRevision.findUnique.mockResolvedValue({
      id: 'draft-1',
      lifecycle: FoundationSettingLifecycle.DRAFT,
      validationResult: { valid: true, issues: [] },
    });
    foundationSettingRevision.updateMany.mockResolvedValue({ count: 1 });
    foundationSettingRevision.findUniqueOrThrow.mockResolvedValue({
      id: 'draft-1',
      lifecycle: FoundationSettingLifecycle.APPROVED,
      lockVersion: 2,
    });

    await expect(
      service.approveDraft(
        { key: FOUNDATION_PROFILE_KEY, revisionVersion: 2, expectedLockVersion: 1 },
        context('administrator-2'),
      ),
    ).resolves.toMatchObject({ lifecycle: FoundationSettingLifecycle.APPROVED, lockVersion: 2 });
    expect(foundationSettingRevision.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lifecycle: FoundationSettingLifecycle.DRAFT,
          lockVersion: 1,
        }),
        data: expect.objectContaining({ approvedBy: 'administrator-2' }),
      }),
    );
  });

  it('does not approve an already-active revision', async () => {
    const { service, foundationSettingRevision } = createSubject();
    foundationSettingRevision.findUnique.mockResolvedValue({
      id: 'active-1',
      lifecycle: FoundationSettingLifecycle.ACTIVE,
      validationResult: { valid: true, issues: [] },
    });

    await expect(
      service.approveDraft(
        { key: FOUNDATION_PROFILE_KEY, revisionVersion: 1, expectedLockVersion: 1 },
        context('administrator-2'),
      ),
    ).rejects.toBeInstanceOf(ConfigurationTransitionError);
  });

  it('activates by appending a new version and recording one safe outbox event', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00.000Z'));
    const { service, foundationSetting, foundationSettingRevision, outboxMessage, audit } =
      createSubject();
    foundationSetting.findUnique.mockResolvedValue({ version: 1, latestRevision: 2 });
    foundationSettingRevision.findUnique.mockResolvedValue({
      version: 2,
      value: profile,
      lifecycle: FoundationSettingLifecycle.APPROVED,
      validationResult: { valid: true, issues: [] },
      authoredBy: 'administrator-1',
      approvedBy: 'administrator-2',
    });
    foundationSetting.updateMany.mockResolvedValue({ count: 1 });
    foundationSettingRevision.updateMany.mockResolvedValue({ count: 1 });
    foundationSettingRevision.create.mockImplementation(({ data }) => data);
    outboxMessage.create.mockResolvedValue({});

    const result = await service.activateApproved(
      { key: FOUNDATION_PROFILE_KEY, revisionVersion: 2, expectedLatestRevision: 2 },
      {
        ...context('administrator-3'),
        correlationId: 'request-configuration-1',
        causationId: 'command-configuration-1',
      },
    );

    expect(result).toMatchObject({
      version: 3,
      lifecycle: FoundationSettingLifecycle.ACTIVE,
      sourceRevisionVersion: 2,
      authoredBy: 'administrator-1',
      approvedBy: 'administrator-2',
      activatedBy: 'administrator-3',
    });
    expect(outboxMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: FOUNDATION_CONFIGURATION_ACTIVATED_EVENT_TYPE,
        aggregateId: FOUNDATION_PROFILE_KEY,
        payload: {
          key: FOUNDATION_PROFILE_KEY,
          activeVersion: 3,
          sourceRevisionVersion: 2,
        },
      }),
    });
    expect(JSON.stringify(outboxMessage.create.mock.calls)).not.toContain('phase-2-ready');
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'configuration.foundation.activated',
        beforeMetadata: { activeVersion: 1, latestRevision: 2 },
        afterMetadata: { activeVersion: 3, latestRevision: 3, sourceRevisionVersion: 2 },
      }),
      expect.objectContaining({ reason: 'Maintain the local foundation profile.' }),
    );
    jest.useRealTimers();
  });
});
