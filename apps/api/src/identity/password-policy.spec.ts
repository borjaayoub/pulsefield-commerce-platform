import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_VERSION,
  PasswordPolicyError,
  validateAndNormalizePassword,
} from './password-policy';

describe('password policy', () => {
  it('publishes a version for auditing policy changes', () => {
    expect(PASSWORD_POLICY_VERSION).toBe('2026-09-01');
  });

  it('accepts a lowercase passphrase without composition rules', () => {
    const password = 'four calm words together';

    expect(validateAndNormalizePassword(password)).toBe(password);
  });

  it('preserves leading and trailing spaces as part of the password', () => {
    const password = '  long password phrase  ';

    expect(validateAndNormalizePassword(password)).toBe(password);
  });

  it('rejects passwords shorter than the minimum length', () => {
    expect(() => validateAndNormalizePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(
      expect.objectContaining<Partial<PasswordPolicyError>>({ code: 'PASSWORD_TOO_SHORT' }),
    );
  });

  it('rejects passwords longer than the maximum length', () => {
    expect(() => validateAndNormalizePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(
      expect.objectContaining<Partial<PasswordPolicyError>>({ code: 'PASSWORD_TOO_LONG' }),
    );
  });

  it('counts Unicode code points rather than UTF-16 code units', () => {
    const password = '🟢'.repeat(MIN_PASSWORD_LENGTH);

    expect(validateAndNormalizePassword(password)).toBe(password);
  });

  it('normalizes canonically equivalent Unicode before hashing', () => {
    const decomposedPassword = `Cafe\u0301-${'a'.repeat(12)}`;
    const composedPassword = `Café-${'a'.repeat(12)}`;

    expect(validateAndNormalizePassword(decomposedPassword)).toBe(composedPassword);
  });

  it('rejects common passwords without relying on letter case', () => {
    expect(() => validateAndNormalizePassword('PasswordPassword')).toThrow(
      expect.objectContaining<Partial<PasswordPolicyError>>({ code: 'PASSWORD_BLOCKLISTED' }),
    );
  });

  it('rejects a password equal to an account-related value', () => {
    expect(() =>
      validateAndNormalizePassword('Ayoub.ExampleShop', {
        relatedValues: ['ayoub.exampleshop'],
      }),
    ).toThrow(
      expect.objectContaining<Partial<PasswordPolicyError>>({ code: 'PASSWORD_BLOCKLISTED' }),
    );
  });

  it('does not include the rejected password in its error', () => {
    const rejectedPassword = 'PasswordPassword';

    expect(() => validateAndNormalizePassword(rejectedPassword)).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining(rejectedPassword) }),
    );
  });
});
