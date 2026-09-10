import * as OTPAuth from 'otpauth';
import { TOTP_PERIOD_SECONDS, TotpService } from './totp.service';

describe('TotpService', () => {
  const service = new TotpService();
  const now = 1_788_350_400_000;

  function codeAt(secret: string, timestamp: number): string {
    return new OTPAuth.TOTP({
      issuer: 'PULSE//FIELD',
      label: 'verification',
      algorithm: 'SHA1',
      digits: 6,
      period: TOTP_PERIOD_SECONDS,
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate({ timestamp });
  }

  it('creates a standards-compatible 160-bit secret and provisioning URI', () => {
    const created = service.create('staff@example.test');
    const uri = new URL(created.provisioningUri);

    expect(OTPAuth.Secret.fromBase32(created.secret).buffer.byteLength).toBe(20);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.hostname).toBe('totp');
    expect(uri.searchParams.get('issuer')).toBe('PULSE//FIELD');
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
    expect(uri.searchParams.get('secret')).toBe(created.secret);
  });

  it.each([-1, 0, 1])('accepts a valid code from window offset %i', (offset) => {
    const secret = service.create('staff@example.test').secret;
    const step = Math.floor(now / (TOTP_PERIOD_SECONDS * 1000)) + offset;
    const code = codeAt(secret, step * TOTP_PERIOD_SECONDS * 1000);

    expect(service.matchingStep(secret, code, now)).toBe(BigInt(step));
  });

  it('matches the RFC 6238 SHA-1 test secret at 59 seconds', () => {
    const rfcSecret = new OTPAuth.Secret({
      buffer: Uint8Array.from(Buffer.from('12345678901234567890', 'ascii')).buffer,
    }).base32;

    expect(service.matchingStep(rfcSecret, '287082', 59_000)).toBe(1n);
  });

  it('rejects malformed codes and codes outside the allowed clock window', () => {
    const secret = service.create('staff@example.test').secret;
    const outsideStep = Math.floor(now / (TOTP_PERIOD_SECONDS * 1000)) + 2;

    expect(service.matchingStep(secret, '12345', now)).toBeNull();
    expect(
      service.matchingStep(secret, codeAt(secret, outsideStep * TOTP_PERIOD_SECONDS * 1000), now),
    ).toBeNull();
  });
});
