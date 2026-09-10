import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { AuditActorType } from '../generated/prisma/enums';
import { UnsafeAuditMetadataError } from './audit.errors';
import { type AuditedCommandContext, normalizeAuditedCommandContext } from './command-context';

const AUDIT_IDENTIFIER_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/u;
const PROHIBITED_METADATA_KEY =
  /(address|authorization|cookie|csrf|email|hash|name|passphrase|password|phone|recovery|secret|token|totp)/iu;
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_PROPERTIES = 32;
const MAX_METADATA_ARRAY_ITEMS = 50;
const MAX_METADATA_STRING_LENGTH = 256;
const MAX_METADATA_BYTES = 4_096;

type SafeAuditScalar = boolean | number | string | null;
type SafeAuditValue = SafeAuditScalar | SafeAuditValue[] | { [key: string]: SafeAuditValue };

export interface AppendAuditRecordInput {
  action: string;
  targetType: string;
  targetId: string;
  beforeMetadata?: unknown;
  afterMetadata?: unknown;
}

export interface AuditRecordWriter {
  auditRecord: {
    create(args: Prisma.AuditRecordCreateArgs): Promise<unknown>;
  };
}

function validateAuditIdentifier(value: string): string {
  if (!AUDIT_IDENTIFIER_PATTERN.test(value)) throw new UnsafeAuditMetadataError();
  return value;
}

function safeValue(value: unknown, depth: number): SafeAuditValue {
  if (depth > MAX_METADATA_DEPTH) throw new UnsafeAuditMetadataError();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= MAX_METADATA_STRING_LENGTH) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY_ITEMS) throw new UnsafeAuditMetadataError();
    return value.map((item) => safeValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new UnsafeAuditMetadataError();
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_PROPERTIES) throw new UnsafeAuditMetadataError();
  const result: Record<string, SafeAuditValue> = {};
  for (const [key, child] of entries) {
    if (
      key.length < 1 ||
      key.length > 64 ||
      !/^[a-zA-Z][a-zA-Z0-9]*$/u.test(key) ||
      PROHIBITED_METADATA_KEY.test(key)
    ) {
      throw new UnsafeAuditMetadataError();
    }
    result[key] = safeValue(child, depth + 1);
  }
  return result;
}

function safeMetadata(value: unknown): Prisma.InputJsonObject | undefined {
  if (value === undefined) return undefined;
  const result = safeValue(value, 0);
  if (!result || Array.isArray(result) || typeof result !== 'object') {
    throw new UnsafeAuditMetadataError();
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_METADATA_BYTES) {
    throw new UnsafeAuditMetadataError();
  }
  return result as Prisma.InputJsonObject;
}

@Injectable()
export class AuditService {
  async append(
    writer: AuditRecordWriter,
    input: AppendAuditRecordInput,
    context: AuditedCommandContext,
  ): Promise<unknown> {
    const normalized = normalizeAuditedCommandContext(context);
    const actorType = {
      customer: AuditActorType.CUSTOMER,
      staff: AuditActorType.STAFF,
      system: AuditActorType.SYSTEM,
    }[normalized.actor.type];

    return writer.auditRecord.create({
      data: {
        schemaVersion: 1,
        actorType,
        actorId: normalized.actor.id,
        actorRoles: normalized.actor.roles,
        action: validateAuditIdentifier(input.action),
        targetType: validateAuditIdentifier(input.targetType),
        targetId: normalizedTargetId(input.targetId),
        requestId: normalized.requestId,
        correlationId: normalized.correlationId,
        causationId: normalized.causationId,
        idempotencyKey: normalized.idempotencyKey,
        reason: normalized.reason,
        beforeMetadata: safeMetadata(input.beforeMetadata),
        afterMetadata: safeMetadata(input.afterMetadata),
      },
    });
  }
}

function normalizedTargetId(value: unknown): string {
  if (typeof value !== 'string') throw new UnsafeAuditMetadataError();
  const normalized = value.trim();
  const containsControl = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    containsControl ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(normalized)
  ) {
    throw new UnsafeAuditMetadataError();
  }
  return normalized;
}
