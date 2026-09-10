import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus } from '../generated/prisma/enums';
import { PasswordHasher } from './password-hasher.service';
import { PasswordPolicyError, validateAndNormalizePassword } from './password-policy';

export const PASSWORD_RESET_TOKEN_BYTES = 32;
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const encodedTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export class InvalidPasswordResetTokenError extends Error {
  readonly name = 'InvalidPasswordResetTokenError';
  readonly code = 'INVALID_PASSWORD_RESET_TOKEN';

  constructor() {
    super('Password reset token is invalid or unavailable.');
  }
}

export interface IssuedPasswordResetToken {
  token: string;
  expiresAt: Date;
}

export interface CompletedPasswordReset {
  userId: string;
  credentialVersion: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

@Injectable()
export class PasswordResetTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async issue(userId: string): Promise<IssuedPasswordResetToken> {
    const token = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);

    await this.prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt,
      },
    });

    return { token, expiresAt };
  }

  async reset(token: string, plainPassword: string): Promise<CompletedPasswordReset> {
    const initiallyNormalizedPassword = validateAndNormalizePassword(plainPassword);

    if (!encodedTokenPattern.test(token)) {
      throw new InvalidPasswordResetTokenError();
    }

    const storedToken = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        consumedAt: true,
        revokedAt: true,
        user: {
          select: {
            emailNormalized: true,
            passwordHash: true,
            credentialVersion: true,
            status: true,
          },
        },
      },
    });

    if (
      !storedToken ||
      storedToken.consumedAt !== null ||
      storedToken.revokedAt !== null ||
      storedToken.expiresAt.getTime() <= Date.now() ||
      storedToken.user.status !== AccountStatus.ACTIVE
    ) {
      throw new InvalidPasswordResetTokenError();
    }

    const emailLocalPart = storedToken.user.emailNormalized.split('@', 1)[0] ?? '';
    const normalizedPassword = validateAndNormalizePassword(initiallyNormalizedPassword, {
      relatedValues: [storedToken.user.emailNormalized, emailLocalPart],
    });

    let reusesCurrentPassword = false;
    try {
      reusesCurrentPassword = await this.passwordHasher.verify(
        normalizedPassword,
        storedToken.user.passwordHash,
      );
    } catch {
      throw new InvalidPasswordResetTokenError();
    }
    if (reusesCurrentPassword) {
      throw new PasswordPolicyError('PASSWORD_REUSE_NOT_ALLOWED');
    }

    const passwordHash = await this.passwordHasher.hash(normalizedPassword);
    const resetAt = new Date();

    return this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.passwordResetToken.updateMany({
        where: {
          id: storedToken.id,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: resetAt },
        },
        data: { consumedAt: resetAt },
      });

      if (claimed.count !== 1) {
        throw new InvalidPasswordResetTokenError();
      }

      const updated = await transaction.user.updateMany({
        where: {
          id: storedToken.userId,
          status: AccountStatus.ACTIVE,
          credentialVersion: storedToken.user.credentialVersion,
        },
        data: {
          passwordHash,
          credentialVersion: { increment: 1 },
        },
      });

      if (updated.count !== 1) {
        throw new InvalidPasswordResetTokenError();
      }

      await transaction.passwordResetToken.updateMany({
        where: {
          userId: storedToken.userId,
          id: { not: storedToken.id },
          consumedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: resetAt },
      });

      return {
        userId: storedToken.userId,
        credentialVersion: storedToken.user.credentialVersion + 1,
      };
    });
  }
}
