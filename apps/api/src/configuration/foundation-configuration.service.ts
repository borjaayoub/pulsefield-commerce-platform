import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import {
  type AuditedCommandContext,
  normalizeAuditedCommandContext,
} from '../audit/command-context';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { FoundationSettingLifecycle } from '../generated/prisma/enums';
import {
  ConfigurationConflictError,
  ConfigurationNotFoundError,
  ConfigurationTransitionError,
  InvalidFoundationConfigurationError,
} from './configuration.errors';

export const FOUNDATION_PROFILE_KEY = 'foundation.profile';
export const FOUNDATION_CONFIGURATION_ACTIVATED_EVENT_TYPE = 'configuration.foundation.activated';
export const FOUNDATION_CONFIGURATION_ACTIVATED_EVENT_VERSION = 1;

const FOUNDATION_PROFILE_PROPERTIES = [
  'paymentProvider',
  'profile',
  'smtpProvider',
  'status',
] as const;

export type FoundationProfileValue = Prisma.InputJsonObject & {
  profile: 'zero-cost-local';
  status: string;
  paymentProvider: 'stub';
  smtpProvider: 'mailpit';
};

export interface CreateFoundationDraftInput {
  key: typeof FOUNDATION_PROFILE_KEY;
  value: unknown;
  expectedLatestRevision: number;
}

export interface RevisionCommandInput {
  key: typeof FOUNDATION_PROFILE_KEY;
  revisionVersion: number;
  expectedLockVersion: number;
}

export interface ActivateFoundationRevisionInput {
  key: typeof FOUNDATION_PROFILE_KEY;
  revisionVersion: number;
  expectedLatestRevision: number;
}

export interface RollbackFoundationRevisionInput {
  key: typeof FOUNDATION_PROFILE_KEY;
  sourceRevisionVersion: number;
  expectedLatestRevision: number;
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new ConfigurationConflictError();
  }
}

function assertFoundationKey(key: string): asserts key is typeof FOUNDATION_PROFILE_KEY {
  if (key !== FOUNDATION_PROFILE_KEY) throw new InvalidFoundationConfigurationError();
}

function normalizeActorId(actorId: unknown): string {
  if (typeof actorId !== 'string') throw new InvalidFoundationConfigurationError();
  const normalized = actorId.trim();
  const containsControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (normalized.length < 1 || normalized.length > 128 || containsControlCharacter) {
    throw new InvalidFoundationConfigurationError();
  }
  return normalized;
}

function validateFoundationProfile(value: unknown): FoundationProfileValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidFoundationConfigurationError();
  }

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== FOUNDATION_PROFILE_PROPERTIES.length ||
    !keys.every((key, index) => key === FOUNDATION_PROFILE_PROPERTIES[index]) ||
    candidate.profile !== 'zero-cost-local' ||
    candidate.paymentProvider !== 'stub' ||
    candidate.smtpProvider !== 'mailpit' ||
    typeof candidate.status !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(candidate.status)
  ) {
    throw new InvalidFoundationConfigurationError();
  }

  return {
    profile: candidate.profile,
    status: candidate.status,
    paymentProvider: candidate.paymentProvider,
    smtpProvider: candidate.smtpProvider,
  };
}

function validationResult(): Prisma.InputJsonObject {
  return { valid: true, issues: [] };
}

function isValidRevisionResult(value: Prisma.JsonValue): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const valid = Reflect.get(value, 'valid');
  const issues = Reflect.get(value, 'issues');
  return valid === true && Array.isArray(issues) && issues.length === 0;
}

function persistedJsonInput(value: Prisma.JsonValue): Prisma.InputJsonValue {
  if (value === null) throw new ConfigurationTransitionError();
  return value as Prisma.InputJsonValue;
}

function assertConfigurationAdministrator(context: AuditedCommandContext): void {
  if (context.actor.type !== 'staff' || !context.actor.roles.includes('ADMINISTRATOR')) {
    throw new InvalidFoundationConfigurationError();
  }
}

@Injectable()
export class FoundationConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async current(key: typeof FOUNDATION_PROFILE_KEY = FOUNDATION_PROFILE_KEY) {
    assertFoundationKey(key);
    const setting = await this.prisma.foundationSetting.findUnique({ where: { key } });
    if (!setting) throw new ConfigurationNotFoundError();
    return setting;
  }

  async createDraft(input: CreateFoundationDraftInput, context: AuditedCommandContext) {
    assertFoundationKey(input.key);
    assertPositiveInteger(input.expectedLatestRevision);
    const command = normalizeAuditedCommandContext(context);
    assertConfigurationAdministrator(command);
    const value = validateFoundationProfile(input.value);
    const authoredBy = normalizeActorId(command.actor.id);
    const nextVersion = input.expectedLatestRevision + 1;

    return this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.foundationSetting.updateMany({
        where: {
          key: input.key,
          latestRevision: input.expectedLatestRevision,
        },
        data: { latestRevision: nextVersion },
      });
      if (claimed.count !== 1) throw new ConfigurationConflictError();

      const revision = await transaction.foundationSettingRevision.create({
        data: {
          settingKey: input.key,
          version: nextVersion,
          value,
          lifecycle: FoundationSettingLifecycle.DRAFT,
          validationResult: validationResult(),
          authoredBy,
        },
      });
      await this.audit.append(
        transaction,
        {
          action: 'configuration.foundation.draft-created',
          targetType: 'foundation-setting',
          targetId: input.key,
          beforeMetadata: { latestRevision: input.expectedLatestRevision },
          afterMetadata: {
            latestRevision: nextVersion,
            revisionVersion: nextVersion,
            lifecycle: FoundationSettingLifecycle.DRAFT,
          },
        },
        command,
      );
      return revision;
    });
  }

  async approveDraft(input: RevisionCommandInput, context: AuditedCommandContext) {
    assertFoundationKey(input.key);
    assertPositiveInteger(input.revisionVersion);
    assertPositiveInteger(input.expectedLockVersion);
    const command = normalizeAuditedCommandContext(context);
    assertConfigurationAdministrator(command);
    const approvedBy = normalizeActorId(command.actor.id);

    return this.prisma.$transaction(async (transaction) => {
      const revision = await transaction.foundationSettingRevision.findUnique({
        where: {
          settingKey_version: {
            settingKey: input.key,
            version: input.revisionVersion,
          },
        },
      });
      if (!revision) throw new ConfigurationNotFoundError();
      if (
        revision.lifecycle !== FoundationSettingLifecycle.DRAFT ||
        !isValidRevisionResult(revision.validationResult)
      ) {
        throw new ConfigurationTransitionError();
      }

      const updated = await transaction.foundationSettingRevision.updateMany({
        where: {
          id: revision.id,
          lifecycle: FoundationSettingLifecycle.DRAFT,
          lockVersion: input.expectedLockVersion,
        },
        data: {
          lifecycle: FoundationSettingLifecycle.APPROVED,
          approvedBy,
          lockVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new ConfigurationConflictError();

      const approved = await transaction.foundationSettingRevision.findUniqueOrThrow({
        where: { id: revision.id },
      });
      await this.audit.append(
        transaction,
        {
          action: 'configuration.foundation.draft-approved',
          targetType: 'foundation-setting',
          targetId: input.key,
          beforeMetadata: {
            revisionVersion: revision.version,
            lifecycle: FoundationSettingLifecycle.DRAFT,
            lockVersion: input.expectedLockVersion,
          },
          afterMetadata: {
            revisionVersion: approved.version,
            lifecycle: FoundationSettingLifecycle.APPROVED,
            lockVersion: approved.lockVersion,
          },
        },
        command,
      );
      return approved;
    });
  }

  async activateApproved(input: ActivateFoundationRevisionInput, context: AuditedCommandContext) {
    return this.activate(input, context, FoundationSettingLifecycle.APPROVED);
  }

  async rollback(input: RollbackFoundationRevisionInput, context: AuditedCommandContext) {
    assertPositiveInteger(input.sourceRevisionVersion);
    return this.activate(
      {
        key: input.key,
        revisionVersion: input.sourceRevisionVersion,
        expectedLatestRevision: input.expectedLatestRevision,
      },
      context,
      FoundationSettingLifecycle.RETIRED,
      true,
    );
  }

  private async activate(
    input: ActivateFoundationRevisionInput,
    context: AuditedCommandContext,
    requiredLifecycle: FoundationSettingLifecycle,
    rollback = false,
  ) {
    assertFoundationKey(input.key);
    assertPositiveInteger(input.revisionVersion);
    assertPositiveInteger(input.expectedLatestRevision);
    const command = normalizeAuditedCommandContext(context);
    assertConfigurationAdministrator(command);
    const actorId = normalizeActorId(command.actor.id);
    const outboxMessageId = randomUUID();
    const correlationId = command.correlationId;

    return this.prisma.$transaction(async (transaction) => {
      const [setting, source] = await Promise.all([
        transaction.foundationSetting.findUnique({ where: { key: input.key } }),
        transaction.foundationSettingRevision.findUnique({
          where: {
            settingKey_version: {
              settingKey: input.key,
              version: input.revisionVersion,
            },
          },
        }),
      ]);
      if (!setting || !source) throw new ConfigurationNotFoundError();
      if (
        source.lifecycle !== requiredLifecycle ||
        !isValidRevisionResult(source.validationResult)
      ) {
        throw new ConfigurationTransitionError();
      }

      const nextVersion = input.expectedLatestRevision + 1;
      const sourceValue = persistedJsonInput(source.value);
      const sourceValidationResult = persistedJsonInput(source.validationResult);
      const claimed = await transaction.foundationSetting.updateMany({
        where: { key: input.key, latestRevision: input.expectedLatestRevision },
        data: {
          value: sourceValue,
          version: nextVersion,
          latestRevision: nextVersion,
        },
      });
      if (claimed.count !== 1) throw new ConfigurationConflictError();

      const now = new Date();
      const retired = await transaction.foundationSettingRevision.updateMany({
        where: {
          settingKey: input.key,
          version: setting.version,
          lifecycle: FoundationSettingLifecycle.ACTIVE,
        },
        data: {
          lifecycle: FoundationSettingLifecycle.RETIRED,
          retiredBy: actorId,
          effectiveUntil: now,
          lockVersion: { increment: 1 },
        },
      });
      if (retired.count !== 1) throw new ConfigurationConflictError();

      const active = await transaction.foundationSettingRevision.create({
        data: {
          settingKey: input.key,
          version: nextVersion,
          value: sourceValue,
          lifecycle: FoundationSettingLifecycle.ACTIVE,
          validationResult: sourceValidationResult,
          authoredBy: rollback ? actorId : source.authoredBy,
          approvedBy: rollback ? actorId : source.approvedBy,
          activatedBy: actorId,
          sourceRevisionVersion: source.version,
          effectiveFrom: now,
        },
      });

      await transaction.outboxMessage.create({
        data: {
          id: outboxMessageId,
          eventType: FOUNDATION_CONFIGURATION_ACTIVATED_EVENT_TYPE,
          eventVersion: FOUNDATION_CONFIGURATION_ACTIVATED_EVENT_VERSION,
          aggregateType: 'FoundationSetting',
          aggregateId: input.key,
          payload: {
            key: input.key,
            activeVersion: nextVersion,
            sourceRevisionVersion: source.version,
          },
          correlationId,
          causationId: command.causationId,
        },
      });

      await this.audit.append(
        transaction,
        {
          action: rollback
            ? 'configuration.foundation.rolled-back'
            : 'configuration.foundation.activated',
          targetType: 'foundation-setting',
          targetId: input.key,
          beforeMetadata: {
            activeVersion: setting.version,
            latestRevision: setting.latestRevision,
          },
          afterMetadata: {
            activeVersion: nextVersion,
            latestRevision: nextVersion,
            sourceRevisionVersion: source.version,
          },
        },
        command,
      );

      return active;
    });
  }
}
