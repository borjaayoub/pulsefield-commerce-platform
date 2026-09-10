const SENSITIVE_KEY =
  /(?:address|authorization|card|cookie|credential|cvv|cvc|email|name|password|phone|secret|token|totp)/iu;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const LONG_DIGIT_VALUE = /\b\d{8,19}\b/gu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~-]+/giu;
const PHONE_VALUE = /(?:\+\d[\d ()-]{7,}\d|\b\d{3}[ ()-]\d{3}[ -]\d{4}\b)/gu;

export function maskAuditIdentifier(value: string): string {
  const suffix = value.slice(-4);
  return suffix.length === 0 ? '[REDACTED]' : `***${suffix}`;
}

export function redactAuditText(value: string): string {
  return value
    .replace(EMAIL_VALUE, '[REDACTED_EMAIL]')
    .replace(BEARER_VALUE, '[REDACTED_CREDENTIAL]')
    .replace(PHONE_VALUE, '[REDACTED_PHONE]')
    .replace(LONG_DIGIT_VALUE, '[REDACTED_NUMBER]');
}

export function maskAuditMetadata(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactAuditText(value);
  if (Array.isArray(value)) return value.map(maskAuditMetadata);
  if (!value || typeof value !== 'object') return '[REDACTED]';

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : maskAuditMetadata(child);
  }
  return result;
}
