import { Injectable } from '@nestjs/common';
import type { CommandContext } from '@pulse-field/contracts';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeCommandContext } from '../audit/command-context';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { AuditActorType, IdempotencyStatus } from '../generated/prisma/enums';
import {
  IdempotencyClaimLostError,
  IdempotencyConflictError,
  InvalidIdempotencyInputError,
} from './idempotency.errors';
import { fingerprintIdempotentRequest } from './request-fingerprint';

const DEFAULT_LEASE_MS = 30_000;
const MINIMUM_LEASE_MS = 1_000;
const MAXIMUM_LEASE_MS = 5 * 60_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MINIMUM_RETENTION_MS = 60 * 60_000;
const MAXIMUM_RETENTION_MS = 30 * 24 * 60 * 60_000;
const OPERATION_PATTERN = /^[a-z][a-z0-9.-]{2,127}$/u;
const RESULT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,127}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;

type IdempotencyWriter = Pick<Prisma.TransactionClient, 'idempotencyRecord'>;

export interface BeginIdempotentCommandInput {
  operation: string;
  request: unknown;
  leaseMs?: number;
  retentionMs?: number;
}

export interface IdempotencyClaim {
  recordId: string;
  token: string;
}

export type BeginIdempotentCommandResult =
  | { kind: 'acquired'; claim: IdempotencyClaim; attemptCount: number }
  | { kind: 'in-progress'; retryAfterMs: number }
  | {
      kind: 'replay';
      result: { type: string; id: string; responseStatus: number };
    };

export interface CompleteIdempotentCommandInput {
  type: string;
  id: string;
  responseStatus: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new InvalidIdempotencyInputError();
  }
  return resolved;
}

function identifier(value: unknown, pattern: RegExp, maximumLength = 128): string {
  if (typeof value !== 'string') throw new InvalidIdempotencyInputError();
  const normalized = value.trim();
  if (normalized.length > maximumLength || !pattern.test(normalized)) {
    throw new InvalidIdempotencyInputError();
  }
  return normalized;
}

function opaqueIdentifier(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidIdempotencyInputError();
  const normalized = value.trim();
  const containsControl = [...normalized].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
  if (normalized.length < 1 || normalized.length > 128 || containsControl) {
    throw new InvalidIdempotencyInputError();
  }
  return normalized;
}

function actorType(type: CommandContext['actor']['type']): AuditActorType {
  return {
    customer: AuditActorType.CUSTOMER,
    staff: AuditActorType.STAFF,
    system: AuditActorType.SYSTEM,
  }[type];
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async begin(
    input: BeginIdempotentCommandInput,
    context: CommandContext,
  ): Promise<BeginIdempotentCommandResult> {
    const command = normalizeCommandContext(context);
    const operation = identifier(input.operation, OPERATION_PATTERN);
    const leaseMs = boundedInteger(
      input.leaseMs,
      DEFAULT_LEASE_MS,
      MINIMUM_LEASE_MS,
      MAXIMUM_LEASE_MS,
    );
    const retentionMs = boundedInteger(
      input.retentionMs,
      DEFAULT_RETENTION_MS,
      MINIMUM_RETENTION_MS,
      MAXIMUM_RETENTION_MS,
    );
    const keyDigest = digest(command.idempotencyKey);
    const requestFingerprint = fingerprintIdempotentRequest(operation, input.request);
    const recordKey = {
      actorType: actorType(command.actor.type),
      actorId: command.actor.id,
      operation,
      keyDigest,
    };

    for (let contentionAttempt = 0; contentionAttempt < 5; contentionAttempt += 1) {
      const now = new Date();
      const token = randomBytes(32).toString('base64url');
      const claimTokenDigest = digest(token);
      const lockedUntil = new Date(now.getTime() + leaseMs);

      if (contentionAttempt === 0) {
        try {
          const created = await this.prisma.idempotencyRecord.create({
            data: {
              ...recordKey,
              requestFingerprint,
              claimTokenDigest,
              lockedUntil,
              expiresAt: new Date(now.getTime() + retentionMs),
            },
          });
          return {
            kind: 'acquired',
            claim: { recordId: created.id, token },
            attemptCount: created.attemptCount,
          };
        } catch (error: unknown) {
          const existing = await this.prisma.idempotencyRecord.findUnique({
            where: { actorType_actorId_operation_keyDigest: recordKey },
          });
          if (!existing) throw error;
        }
      }

      const existing = await this.prisma.idempotencyRecord.findUniqueOrThrow({
        where: { actorType_actorId_operation_keyDigest: recordKey },
      });
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new IdempotencyConflictError();
      }
      if (existing.status === IdempotencyStatus.COMPLETED) {
        if (!existing.resultType || !existing.resultId || !existing.responseStatus) {
          throw new IdempotencyClaimLostError();
        }
        return {
          kind: 'replay',
          result: {
            type: existing.resultType,
            id: existing.resultId,
            responseStatus: existing.responseStatus,
          },
        };
      }
      if (
        existing.status === IdempotencyStatus.IN_PROGRESS &&
        existing.lockedUntil &&
        existing.lockedUntil.getTime() > now.getTime()
      ) {
        return {
          kind: 'in-progress',
          retryAfterMs: Math.max(1, existing.lockedUntil.getTime() - now.getTime()),
        };
      }

      const reclaimed = await this.prisma.idempotencyRecord.updateMany({
        where: {
          id: existing.id,
          requestFingerprint,
          OR: [
            { status: IdempotencyStatus.FAILED_RETRYABLE },
            { status: IdempotencyStatus.IN_PROGRESS, lockedUntil: { lte: now } },
          ],
        },
        data: {
          status: IdempotencyStatus.IN_PROGRESS,
          claimTokenDigest,
          lockedUntil,
          attemptCount: { increment: 1 },
          lastErrorCode: null,
          expiresAt: new Date(now.getTime() + retentionMs),
        },
      });
      if (reclaimed.count === 1) {
        return {
          kind: 'acquired',
          claim: { recordId: existing.id, token },
          attemptCount: existing.attemptCount + 1,
        };
      }
    }

    throw new IdempotencyClaimLostError();
  }

  async complete(
    writer: IdempotencyWriter,
    claim: IdempotencyClaim,
    result: CompleteIdempotentCommandInput,
  ): Promise<void> {
    const resultType = identifier(result.type, RESULT_TYPE_PATTERN);
    const resultId = opaqueIdentifier(result.id);
    if (
      !Number.isInteger(result.responseStatus) ||
      result.responseStatus < 200 ||
      result.responseStatus > 299
    ) {
      throw new InvalidIdempotencyInputError();
    }
    const completedAt = new Date();
    const updated = await writer.idempotencyRecord.updateMany({
      where: {
        id: opaqueIdentifier(claim.recordId),
        status: IdempotencyStatus.IN_PROGRESS,
        claimTokenDigest: digest(opaqueIdentifier(claim.token)),
      },
      data: {
        status: IdempotencyStatus.COMPLETED,
        claimTokenDigest: null,
        lockedUntil: null,
        resultType,
        resultId,
        responseStatus: result.responseStatus,
        completedAt,
      },
    });
    if (updated.count !== 1) throw new IdempotencyClaimLostError();
  }

  async fail(claim: IdempotencyClaim, errorCode: string): Promise<void> {
    const normalizedErrorCode = identifier(errorCode, ERROR_CODE_PATTERN, 64);
    const updated = await this.prisma.idempotencyRecord.updateMany({
      where: {
        id: opaqueIdentifier(claim.recordId),
        status: IdempotencyStatus.IN_PROGRESS,
        claimTokenDigest: digest(opaqueIdentifier(claim.token)),
      },
      data: {
        status: IdempotencyStatus.FAILED_RETRYABLE,
        claimTokenDigest: null,
        lockedUntil: null,
        lastErrorCode: normalizedErrorCode,
      },
    });
    if (updated.count !== 1) throw new IdempotencyClaimLostError();
  }
}
