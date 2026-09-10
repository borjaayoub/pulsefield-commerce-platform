import { createHash } from 'node:crypto';
import { InvalidIdempotencyInputError } from './idempotency.errors';

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_PROPERTIES = 64;
const MAX_SERIALIZED_BYTES = 16 * 1024;
const PROHIBITED_KEY =
  /(?:password|passphrase|secret|token|credential|authorization|cookie|clientsecret|privatekey|cardnumber|cvv|cvc)/iu;

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | CanonicalObject;
type CanonicalObject = { [key: string]: CanonicalValue };

function canonicalValue(value: unknown, depth: number): CanonicalValue {
  if (depth > MAX_DEPTH) throw new InvalidIdempotencyInputError();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new InvalidIdempotencyInputError();
    return value.map((item) => canonicalValue(item, depth + 1));
  }

  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new InvalidIdempotencyInputError();
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (entries.length > MAX_OBJECT_PROPERTIES) throw new InvalidIdempotencyInputError();
  const result: CanonicalObject = {};
  for (const [key, child] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key) || PROHIBITED_KEY.test(key)) {
      throw new InvalidIdempotencyInputError();
    }
    result[key] = canonicalValue(child, depth + 1);
  }
  return result;
}

export function fingerprintIdempotentRequest(operation: string, input: unknown): string {
  const canonical = JSON.stringify(canonicalValue(input, 0));
  if (Buffer.byteLength(canonical, 'utf8') > MAX_SERIALIZED_BYTES) {
    throw new InvalidIdempotencyInputError();
  }
  return createHash('sha256').update(operation).update('\0').update(canonical).digest('hex');
}
