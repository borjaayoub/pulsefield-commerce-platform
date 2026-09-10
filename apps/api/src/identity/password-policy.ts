import { normalizePassword } from './normalize-password';

export const PASSWORD_POLICY_VERSION = '2026-09-01';
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordPolicyErrorCode =
  | 'PASSWORD_TOO_SHORT'
  | 'PASSWORD_TOO_LONG'
  | 'PASSWORD_BLOCKLISTED'
  | 'PASSWORD_REUSE_NOT_ALLOWED';

const passwordPolicyMessages: Record<PasswordPolicyErrorCode, string> = {
  PASSWORD_TOO_SHORT: `Password must contain at least ${MIN_PASSWORD_LENGTH} characters.`,
  PASSWORD_TOO_LONG: `Password must contain no more than ${MAX_PASSWORD_LENGTH} characters.`,
  PASSWORD_BLOCKLISTED: 'Password is too common or too closely related to the account.',
  PASSWORD_REUSE_NOT_ALLOWED: 'The new password must be different from the current password.',
};

// This local list is intentionally small and reviewable. It catches high-value
// common and application-specific choices without requiring a network service.
const blockedPasswords = new Set([
  '123456789012345',
  'changemechangeme',
  'correcthorsebatterystaple',
  'ecommercepassword',
  'iloveyouiloveyou',
  'letmeinletmein',
  'onlineshopping123',
  'password123456',
  'passwordpassword',
  'pulse-field-password',
  'pulsefield123456',
  'pulsefieldpassword',
  'qwertyuiopasdfgh',
  'thisisapassword',
  'welcome-welcome',
]);

export class PasswordPolicyError extends Error {
  readonly name = 'PasswordPolicyError';

  constructor(readonly code: PasswordPolicyErrorCode) {
    super(passwordPolicyMessages[code]);
  }
}

export interface PasswordPolicyContext {
  relatedValues?: readonly string[];
}

function comparablePassword(value: string): string {
  return normalizePassword(value).toLowerCase();
}

export function validateAndNormalizePassword(
  plainPassword: string,
  context: PasswordPolicyContext = {},
): string {
  const normalizedPassword = normalizePassword(plainPassword);
  const length = Array.from(normalizedPassword).length;

  if (length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError('PASSWORD_TOO_SHORT');
  }

  if (length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError('PASSWORD_TOO_LONG');
  }

  const comparable = comparablePassword(normalizedPassword);
  const matchesRelatedValue = context.relatedValues?.some((value) => {
    const relatedValue = comparablePassword(value.trim());
    return relatedValue.length > 0 && comparable === relatedValue;
  });

  if (blockedPasswords.has(comparable) || matchesRelatedValue) {
    throw new PasswordPolicyError('PASSWORD_BLOCKLISTED');
  }

  return normalizedPassword;
}
