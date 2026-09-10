import { Injectable } from '@nestjs/common';
import * as OTPAuth from 'otpauth';
import { timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

function totp(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'PULSE//FIELD',
    label,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

function equalCode(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'ascii');
  const rightBytes = Buffer.from(right, 'ascii');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

@Injectable()
export class TotpService {
  create(label: string): { secret: string; provisioningUri: string } {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    return { secret, provisioningUri: totp(secret, label).toString() };
  }

  matchingStep(secret: string, code: string, now = Date.now()): bigint | null {
    if (!/^\d{6}$/.test(code)) return null;
    const currentStep = Math.floor(now / (TOTP_PERIOD_SECONDS * 1000));
    const generator = totp(secret, 'verification');

    for (const offset of [0, -1, 1]) {
      const step = currentStep + offset;
      const candidate = generator.generate({ timestamp: step * TOTP_PERIOD_SECONDS * 1000 });
      if (equalCode(candidate, code)) return BigInt(step);
    }
    return null;
  }
}
