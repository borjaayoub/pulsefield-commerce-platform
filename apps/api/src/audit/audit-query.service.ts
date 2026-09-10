import { Injectable } from '@nestjs/common';
import type { AuditedCommandContext } from './command-context';
import { normalizeAuditedCommandContext } from './command-context';
import { PrismaService } from '../database/prisma.service';
import type { AuditRecord, Prisma } from '../generated/prisma/client';
import { AuditActorType } from '../generated/prisma/enums';
import { assertAuditReader, type AuditReaderContext } from './audit-access';
import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor';
import { InvalidAuditQueryError } from './audit.errors';
import { maskAuditIdentifier, maskAuditMetadata, redactAuditText } from './audit-mask';
import { AuditService } from './audit.service';

const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 100;
const DEFAULT_EXPORT_SIZE = 1_000;
const MAXIMUM_EXPORT_SIZE = 1_000;
const MAXIMUM_QUERY_RANGE_MS = 366 * 24 * 60 * 60_000;
const AUDIT_IDENTIFIER_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/u;
const CONTEXT_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;

export interface AuditQueryInput {
  limit?: number;
  cursor?: string;
  occurredFrom?: Date;
  occurredTo?: Date;
  actorType?: AuditActorType;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  correlationId?: string;
}

export interface AuditRecordView {
  id: string;
  schemaVersion: number;
  actor: { type: AuditActorType; id: string; roles: string[] };
  action: string;
  target: { type: string; id: string };
  requestId: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
  reason: string;
  beforeMetadata: unknown;
  afterMetadata: unknown;
  occurredAt: string;
}

export interface AuditPage {
  records: AuditRecordView[];
  nextCursor: string | null;
}

export interface AuditExportContext extends AuditedCommandContext {
  authenticationAssurance: AuditReaderContext['authenticationAssurance'];
  authenticatedAt: Date;
}

interface AuditRecordReader {
  auditRecord: {
    findMany(arguments_: Prisma.AuditRecordFindManyArgs): Promise<AuditRecord[]>;
  };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new InvalidAuditQueryError();
  }
  return result;
}

function validDate(value: Date | undefined): Date | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidAuditQueryError();
  }
  return value;
}

function identifier(value: string | undefined, pattern: RegExp): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new InvalidAuditQueryError();
  return normalized;
}

function opaqueIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const control = [...normalized].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
  if (normalized.length < 1 || normalized.length > 128 || control) {
    throw new InvalidAuditQueryError();
  }
  return normalized;
}

function view(record: AuditRecord): AuditRecordView {
  return {
    id: record.id,
    schemaVersion: record.schemaVersion,
    actor: {
      type: record.actorType,
      id: maskAuditIdentifier(record.actorId),
      roles: record.actorRoles,
    },
    action: record.action,
    target: { type: record.targetType, id: maskAuditIdentifier(record.targetId) },
    requestId: record.requestId,
    correlationId: record.correlationId,
    causationId: record.causationId,
    idempotencyKey: maskAuditIdentifier(record.idempotencyKey),
    reason: redactAuditText(record.reason),
    beforeMetadata: maskAuditMetadata(record.beforeMetadata),
    afterMetadata: maskAuditMetadata(record.afterMetadata),
    occurredAt: record.occurredAt.toISOString(),
  };
}

@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(input: AuditQueryInput, context: AuditReaderContext): Promise<AuditPage> {
    assertAuditReader(context);
    return this.query(this.prisma as unknown as AuditRecordReader, input, MAXIMUM_PAGE_SIZE);
  }

  async export(input: AuditQueryInput, context: AuditExportContext): Promise<AuditPage> {
    const command = normalizeAuditedCommandContext(context);
    assertAuditReader({
      actor: command.actor,
      authenticationAssurance: context.authenticationAssurance,
      authenticatedAt: context.authenticatedAt,
    });

    return this.prisma.$transaction(async (transaction) => {
      const page = await this.query(
        transaction as unknown as AuditRecordReader,
        { ...input, limit: input.limit ?? DEFAULT_EXPORT_SIZE },
        MAXIMUM_EXPORT_SIZE,
      );
      const filterCount = [
        input.occurredFrom,
        input.occurredTo,
        input.actorType,
        input.actorId,
        input.action,
        input.targetType,
        input.targetId,
        input.correlationId,
      ].filter((value) => value !== undefined).length;
      await this.audit.append(
        transaction,
        {
          action: 'audit.history.exported',
          targetType: 'audit-history',
          targetId: 'audit-history',
          afterMetadata: {
            recordCount: page.records.length,
            filterCount,
            hasMore: page.nextCursor !== null,
          },
        },
        command,
      );
      return page;
    });
  }

  private async query(
    reader: AuditRecordReader,
    input: AuditQueryInput,
    maximumLimit: number,
  ): Promise<AuditPage> {
    const limit = boundedLimit(
      input.limit,
      maximumLimit === MAXIMUM_EXPORT_SIZE ? DEFAULT_EXPORT_SIZE : DEFAULT_PAGE_SIZE,
      maximumLimit,
    );
    if (input.actorType !== undefined && !Object.values(AuditActorType).includes(input.actorType)) {
      throw new InvalidAuditQueryError();
    }
    const occurredFrom = validDate(input.occurredFrom);
    const occurredTo = validDate(input.occurredTo);
    if (
      occurredFrom &&
      occurredTo &&
      (occurredFrom >= occurredTo ||
        occurredTo.getTime() - occurredFrom.getTime() > MAXIMUM_QUERY_RANGE_MS)
    ) {
      throw new InvalidAuditQueryError();
    }

    const where: Prisma.AuditRecordWhereInput = {
      actorType: input.actorType,
      actorId: opaqueIdentifier(input.actorId),
      action: identifier(input.action, AUDIT_IDENTIFIER_PATTERN),
      targetType: identifier(input.targetType, AUDIT_IDENTIFIER_PATTERN),
      targetId: opaqueIdentifier(input.targetId),
      correlationId: identifier(input.correlationId, CONTEXT_IDENTIFIER_PATTERN),
      occurredAt:
        occurredFrom || occurredTo
          ? {
              ...(occurredFrom ? { gte: occurredFrom } : {}),
              ...(occurredTo ? { lt: occurredTo } : {}),
            }
          : undefined,
    };
    if (input.cursor) {
      const cursor = decodeAuditCursor(input.cursor);
      where.AND = [
        {
          OR: [
            { occurredAt: { lt: cursor.occurredAt } },
            { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    const records = await reader.auditRecord.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = records.length > limit;
    const visible = hasMore ? records.slice(0, limit) : records;
    const last = visible.at(-1);
    return {
      records: visible.map(view),
      nextCursor: hasMore && last ? encodeAuditCursor(last) : null,
    };
  }
}
