import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { normalizePassword } from './normalize-password';

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  version: 0x13,
  memoryCost: 1 << 16,
  timeCost: 3,
  parallelism: 4,
} as const;

@Injectable()
export class PasswordHasher {
  async hash(plainPassword: string): Promise<string> {
    return argon2.hash(normalizePassword(plainPassword), ARGON2ID_OPTIONS);
  }

  async verify(plainPassword: string, storedHash: string): Promise<boolean> {
    return argon2.verify(storedHash, normalizePassword(plainPassword));
  }
}
