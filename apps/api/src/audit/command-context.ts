import type { ActorType, CommandContext } from '@pulse-field/contracts';
import { InvalidCommandContextError } from './audit.errors';

export interface AuditedCommandContext extends CommandContext {
  reason: string;
}

export interface NormalizedCommandContext extends CommandContext {
  actor: {
    type: ActorType;
    id: string;
    roles: string[];
  };
}

export interface NormalizedAuditedCommandContext extends NormalizedCommandContext {
  reason: string;
}

const CONTEXT_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const ROLE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const EMAIL_VALUE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE_VALUE_PATTERN = /(?:\+\d[\d ()-]{7,}\d|\b\d{3}[ ()-]\d{3}[ -]\d{4}\b)/u;
const BEARER_VALUE_PATTERN = /\bBearer\s+[A-Za-z0-9._~-]+/iu;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function normalizeIdentifier(value: unknown, minimumLength = 1, maximumLength = 128): string {
  if (typeof value !== 'string') throw new InvalidCommandContextError();
  const normalized = value.trim();
  if (
    normalized.length < minimumLength ||
    normalized.length > maximumLength ||
    containsControlCharacter(normalized)
  ) {
    throw new InvalidCommandContextError();
  }
  return normalized;
}

function normalizeContextIdentifier(value: unknown): string {
  const normalized = normalizeIdentifier(value, 8);
  if (!CONTEXT_IDENTIFIER_PATTERN.test(normalized)) throw new InvalidCommandContextError();
  return normalized;
}

export function normalizeCommandContext(context: CommandContext): NormalizedCommandContext {
  if (!context || typeof context !== 'object') throw new InvalidCommandContextError();
  if (!['customer', 'staff', 'system'].includes(context.actor?.type)) {
    throw new InvalidCommandContextError();
  }
  if (!Array.isArray(context.actor.roles) || context.actor.roles.length > 16) {
    throw new InvalidCommandContextError();
  }
  const roles = [...new Set(context.actor.roles)];
  if (roles.some((role) => typeof role !== 'string' || !ROLE_PATTERN.test(role))) {
    throw new InvalidCommandContextError();
  }
  roles.sort();

  return {
    requestId: normalizeContextIdentifier(context.requestId),
    correlationId: normalizeContextIdentifier(context.correlationId),
    causationId:
      context.causationId === undefined
        ? undefined
        : normalizeContextIdentifier(context.causationId),
    idempotencyKey: normalizeContextIdentifier(context.idempotencyKey),
    actor: {
      type: context.actor.type,
      id: normalizeIdentifier(context.actor.id),
      roles,
    },
  };
}

export function normalizeAuditedCommandContext(
  context: AuditedCommandContext,
): NormalizedAuditedCommandContext {
  const command = normalizeCommandContext(context);
  const reason = normalizeIdentifier(context.reason, 1, 500);
  if (
    EMAIL_VALUE_PATTERN.test(command.actor.id) ||
    EMAIL_VALUE_PATTERN.test(reason) ||
    PHONE_VALUE_PATTERN.test(reason) ||
    BEARER_VALUE_PATTERN.test(reason)
  ) {
    throw new InvalidCommandContextError();
  }
  return {
    ...command,
    reason,
  };
}
