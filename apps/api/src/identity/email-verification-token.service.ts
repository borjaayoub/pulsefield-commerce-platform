import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus } from '../generated/prisma/enums';

export const EMAIL_VERIFICATION_TOKEN_BYTES = 32;
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const encodedTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export class InvalidEmailVerificationTokenError extends Error {
  readonly name = 'InvalidEmailVerificationTokenError';
  readonly code = 'INVALID_EMAIL_VERIFICATION_TOKEN';

  constructor() {
    super('Email verification token is invalid or unavailable.');
  }
}

export interface IssuedEmailVerificationToken {
  token: string;
  expiresAt: Date;
}

export interface ConsumedEmailVerificationToken {
  userId: string;
  verifiedAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

@Injectable()
export class EmailVerificationTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(userId: string): Promise<IssuedEmailVerificationToken> {
    const token = randomBytes(EMAIL_VERIFICATION_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS);

    await this.prisma.emailVerificationToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt,
      },
    });

    return { token, expiresAt };
  }

  async consume(token: string): Promise<ConsumedEmailVerificationToken> {
    if (!encodedTokenPattern.test(token)) {
      throw new InvalidEmailVerificationTokenError();
    }

    const tokenHash = hashToken(token);
    const verifiedAt = new Date();

    return this.prisma.$transaction(async (transaction) => {
      const storedToken = await transaction.emailVerificationToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
        },
      });

      if (!storedToken) {
        throw new InvalidEmailVerificationTokenError();
      }

      const claimed = await transaction.emailVerificationToken.updateMany({
        where: {
          id: storedToken.id,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: verifiedAt },
        },
        data: { consumedAt: verifiedAt },
      });

      if (claimed.count !== 1) {
        throw new InvalidEmailVerificationTokenError();
      }

      const activated = await transaction.user.updateMany({
        where: {
          id: storedToken.userId,
          status: AccountStatus.PENDING_VERIFICATION,
        },
        data: {
          status: AccountStatus.ACTIVE,
          verifiedAt,
        },
      });

      if (activated.count !== 1) {
        throw new InvalidEmailVerificationTokenError();
      }

      await transaction.emailVerificationToken.updateMany({
        where: {
          userId: storedToken.userId,
          id: { not: storedToken.id },
          consumedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: verifiedAt },
      });

      return {
        userId: storedToken.userId,
        verifiedAt,
      };
    });
  }
}
