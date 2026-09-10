import { randomUUID } from 'node:crypto';
import { MfaSecretProtectionError, TotpSecretProtector } from './totp-secret-protector.service';

describe('TotpSecretProtector', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const protector = new TotpSecretProtector({ current: key });
  const userId = randomUUID();

  it('round-trips a secret without storing it in plaintext and uses a fresh nonce', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const first = protector.protect(secret, userId);
    const second = protector.protect(secret, userId);

    expect(first).not.toContain(secret);
    expect(first).not.toBe(second);
    expect(protector.unprotect(first, userId)).toBe(secret);
    expect(protector.unprotect(second, userId)).toBe(secret);
  });

  it('binds ciphertext to its user and rejects tampering', () => {
    const protectedSecret = protector.protect('JBSWY3DPEHPK3PXP', userId);
    const envelope = JSON.parse(protectedSecret) as { ciphertext: string };
    envelope.ciphertext = Buffer.from('tampered').toString('base64');

    expect(() => protector.unprotect(protectedSecret, randomUUID())).toThrow(
      MfaSecretProtectionError,
    );
    expect(() => protector.unprotect(JSON.stringify(envelope), userId)).toThrow(
      MfaSecretProtectionError,
    );
  });

  it('reads a previous-key secret during rotation and writes it with the active key', () => {
    const oldKey = Buffer.alloc(32, 3).toString('base64');
    const newKey = Buffer.alloc(32, 4).toString('base64');
    const oldProtector = new TotpSecretProtector({ current: oldKey });
    const rotatingProtector = new TotpSecretProtector({ current: newKey, previous: oldKey });
    const oldCiphertext = oldProtector.protect('JBSWY3DPEHPK3PXP', userId);

    expect(rotatingProtector.unprotect(oldCiphertext, userId)).toBe('JBSWY3DPEHPK3PXP');
    expect(rotatingProtector.isProtectedWithActiveKey(oldCiphertext)).toBe(false);

    const reprotected = rotatingProtector.protect(
      rotatingProtector.unprotect(oldCiphertext, userId),
      userId,
    );
    expect(rotatingProtector.isProtectedWithActiveKey(reprotected)).toBe(true);
    expect(new TotpSecretProtector({ current: newKey }).unprotect(reprotected, userId)).toBe(
      'JBSWY3DPEHPK3PXP',
    );
  });
});
