import { InvalidAuditQueryError } from './audit.errors';

export interface AuditCursor {
  occurredAt: Date;
  id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(
    JSON.stringify({ version: 1, occurredAt: cursor.occurredAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeAuditCursor(value: string): AuditCursor {
  if (typeof value !== 'string' || value.length < 16 || value.length > 256) {
    throw new InvalidAuditQueryError();
  }

  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new InvalidAuditQueryError();
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidAuditQueryError();
    }
    const version = Reflect.get(parsed, 'version');
    const occurredAtValue = Reflect.get(parsed, 'occurredAt');
    const id = Reflect.get(parsed, 'id');
    const occurredAt = new Date(typeof occurredAtValue === 'string' ? occurredAtValue : 'invalid');
    if (
      version !== 1 ||
      typeof id !== 'string' ||
      !UUID_PATTERN.test(id) ||
      !Number.isFinite(occurredAt.getTime()) ||
      occurredAt.toISOString() !== occurredAtValue
    ) {
      throw new InvalidAuditQueryError();
    }
    return { occurredAt, id };
  } catch (error: unknown) {
    if (error instanceof InvalidAuditQueryError) throw error;
    throw new InvalidAuditQueryError();
  }
}
