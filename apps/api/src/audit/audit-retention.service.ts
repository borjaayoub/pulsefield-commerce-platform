import { Injectable } from '@nestjs/common';
import type { AuditedCommandContext } from './command-context';
import { normalizeAuditedCommandContext } from './command-context';
import { PrismaService } from '../database/prisma.service';
import { assertAuditReader, type AuditReaderContext } from './audit-access';
import { AuditRetentionConflictError, AuditRetentionHeldError } from './audit.errors';
import { AuditService } from './audit.service';

export const AUDIT_RETENTION_DAYS = 30;
const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * 24 * 60 * 60_000;
const MAXIMUM_HOLD_MS = 30 * 24 * 60 * 60_000;
const MINIMUM_HOLD_MS = 60_000;
const MAXIMUM_PURGE_BATCH = 1_000;

export interface AuditAdministratorContext extends AuditedCommandContext {
  authenticationAssurance: AuditReaderContext['authenticationAssurance'];
  authenticatedAt: Date;
}

function assertAdministrator(context: AuditAdministratorContext) {
  const command = normalizeAuditedCommandContext(context);
  assertAuditReader({
    actor: command.actor,
    authenticationAssurance: context.authenticationAssurance,
    authenticatedAt: context.authenticatedAt,
  });
  return command;
}

function assertRetentionSystem(context: AuditedCommandContext) {
  const command = normalizeAuditedCommandContext(context);
  if (command.actor.type !== 'system' || !command.actor.roles.includes('AUDIT_RETENTION')) {
    throw new AuditRetentionConflictError();
  }
  return command;
}

@Injectable()
export class AuditRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createHold(expiresAt: Date, context: AuditAdministratorContext) {
    const command = assertAdministrator(context);
    const now = new Date();
    if (
      !(expiresAt instanceof Date) ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() - now.getTime() < MINIMUM_HOLD_MS ||
      expiresAt.getTime() - now.getTime() > MAXIMUM_HOLD_MS
    ) {
      throw new AuditRetentionConflictError();
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext('pulse-field:audit-retention'))`;
      const hold = await transaction.auditRetentionHold.create({
        data: {
          reason: command.reason,
          createdBy: command.actor.id,
          expiresAt,
        },
      });
      await this.audit.append(
        transaction,
        {
          action: 'audit.retention-hold.created',
          targetType: 'audit-retention-hold',
          targetId: hold.id,
          afterMetadata: { expiresAt: expiresAt.toISOString() },
        },
        command,
      );
      return hold;
    });
  }

  async releaseHold(holdId: string, context: AuditAdministratorContext) {
    const command = assertAdministrator(context);
    if (typeof holdId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(holdId)) {
      throw new AuditRetentionConflictError();
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext('pulse-field:audit-retention'))`;
      const releasedAt = new Date();
      const released = await transaction.auditRetentionHold.updateMany({
        where: { id: holdId, releasedAt: null },
        data: { releasedAt, releasedBy: command.actor.id },
      });
      if (released.count !== 1) throw new AuditRetentionConflictError();
      const hold = await transaction.auditRetentionHold.findUniqueOrThrow({
        where: { id: holdId },
      });
      await this.audit.append(
        transaction,
        {
          action: 'audit.retention-hold.released',
          targetType: 'audit-retention-hold',
          targetId: hold.id,
          beforeMetadata: { expiresAt: hold.expiresAt.toISOString() },
          afterMetadata: { releasedAt: releasedAt.toISOString() },
        },
        command,
      );
      return hold;
    });
  }

  async purgeExpired(batchSize: number, context: AuditedCommandContext): Promise<number> {
    const command = assertRetentionSystem(context);
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAXIMUM_PURGE_BATCH) {
      throw new AuditRetentionConflictError();
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext('pulse-field:audit-retention'))`;
      const now = new Date();
      const activeHold = await transaction.auditRetentionHold.findFirst({
        where: { releasedAt: null, expiresAt: { gt: now } },
        select: { id: true },
      });
      if (activeHold) throw new AuditRetentionHeldError();

      const cutoff = new Date(now.getTime() - AUDIT_RETENTION_MS);
      const candidates = await transaction.auditRecord.findMany({
        where: { occurredAt: { lt: cutoff } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: batchSize,
        select: { id: true },
      });
      if (candidates.length === 0) return 0;

      await transaction.$queryRaw`SELECT set_config('pulse_field.audit_retention', 'enabled', true)`;
      const deleted = await transaction.auditRecord.deleteMany({
        where: { id: { in: candidates.map(({ id }) => id) } },
      });
      if (deleted.count !== candidates.length) throw new AuditRetentionConflictError();

      await this.audit.append(
        transaction,
        {
          action: 'audit.retention.executed',
          targetType: 'audit-history',
          targetId: 'audit-history',
          afterMetadata: {
            deletedCount: deleted.count,
            retentionDays: AUDIT_RETENTION_DAYS,
          },
        },
        command,
      );
      return deleted.count;
    });
  }
}
