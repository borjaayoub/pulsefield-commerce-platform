import { Injectable } from '@nestjs/common';
import type { AuditedCommandContext } from '../audit/command-context';
import { normalizeAuditedCommandContext } from '../audit/command-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { IdempotencyStatus } from '../generated/prisma/enums';
import { IdempotencyRetentionConflictError } from './idempotency.errors';

export const IDEMPOTENCY_RETENTION_BATCH_SIZE = 250;

function assertRetentionSystem(context: AuditedCommandContext) {
  const command = normalizeAuditedCommandContext(context);
  if (command.actor.type !== 'system' || !command.actor.roles.includes('IDEMPOTENCY_RETENTION')) {
    throw new IdempotencyRetentionConflictError();
  }
  return command;
}

@Injectable()
export class IdempotencyRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async purgeExpired(batchSize: number, context: AuditedCommandContext): Promise<number> {
    const command = assertRetentionSystem(context);
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > IDEMPOTENCY_RETENTION_BATCH_SIZE
    ) {
      throw new IdempotencyRetentionConflictError();
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext('pulse-field:idempotency-retention'))`;
      const now = new Date();
      const eligibility = {
        expiresAt: { lt: now },
        OR: [
          { status: { in: [IdempotencyStatus.COMPLETED, IdempotencyStatus.FAILED_RETRYABLE] } },
          { status: IdempotencyStatus.IN_PROGRESS, lockedUntil: { lt: now } },
        ],
      };
      const candidates = await transaction.idempotencyRecord.findMany({
        where: eligibility,
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: batchSize,
        select: { id: true },
      });
      if (candidates.length === 0) return 0;

      const deleted = await transaction.idempotencyRecord.deleteMany({
        where: { AND: [eligibility, { id: { in: candidates.map(({ id }) => id) } }] },
      });
      if (deleted.count !== candidates.length) throw new IdempotencyRetentionConflictError();

      await this.audit.append(
        transaction,
        {
          action: 'idempotency.retention.executed',
          targetType: 'idempotency-history',
          targetId: 'idempotency-history',
          afterMetadata: {
            deletedCount: deleted.count,
            batchSize,
          },
        },
        command,
      );
      return deleted.count;
    });
  }
}
