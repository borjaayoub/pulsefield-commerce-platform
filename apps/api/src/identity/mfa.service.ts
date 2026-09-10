import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus } from '../generated/prisma/enums';
import type { AuthenticatedPrincipal } from './credential-authentication.service';
import { requiresStaffMfa, STAFF_ROLES } from './authorization.service';
import { MfaAuthenticationFailedError, MfaServiceUnavailableError } from './authentication.errors';
import { MfaChallengeStore, type MfaChallengePurpose } from './mfa-challenge.store';
import { TotpSecretProtector } from './totp-secret-protector.service';
import { TotpService } from './totp.service';
import { PasswordHasher } from './password-hasher.service';

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_PATTERN = /^[A-Fa-f0-9]{5}(-[A-Fa-f0-9]{5}){3}$/;

function recoveryCode(): string {
  return randomBytes(10)
    .toString('hex')
    .toUpperCase()
    .match(/.{1,5}/g)!
    .join('-');
}

function recoveryHash(code: string): string {
  return createHash('sha256').update(code.replaceAll('-', '').toUpperCase()).digest('hex');
}

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly challenges: MfaChallengeStore,
    private readonly totp: TotpService,
    private readonly protector: TotpSecretProtector,
    private readonly passwords: PasswordHasher,
  ) {}

  async begin(principal: AuthenticatedPrincipal) {
    if (!requiresStaffMfa(principal.roles)) throw new MfaAuthenticationFailedError();

    if (principal.mfaEnrolled) {
      const challenge = await this.challenges.create({
        purpose: 'AUTHENTICATION',
        userId: principal.id,
        credentialVersion: principal.credentialVersion,
      });
      return {
        status: 'MFA_REQUIRED' as const,
        challengeToken: challenge.token,
        expiresAt: new Date(challenge.record.expiresAt).toISOString(),
      };
    }

    const created = this.totp.create(principal.email);
    const challenge = await this.challenges.create({
      purpose: 'ENROLLMENT',
      userId: principal.id,
      credentialVersion: principal.credentialVersion,
      protectedTotpSecret: this.protector.protect(created.secret, principal.id),
    });
    return {
      status: 'MFA_ENROLLMENT_REQUIRED' as const,
      challengeToken: challenge.token,
      expiresAt: new Date(challenge.record.expiresAt).toISOString(),
      sharedSecret: created.secret,
      provisioningUri: created.provisioningUri,
    };
  }

  async enroll(challengeToken: string, totpCode: string) {
    const challenge = await this.readChallenge(challengeToken, 'ENROLLMENT');
    if (!challenge.protectedTotpSecret) throw new MfaAuthenticationFailedError();
    const secret = this.unprotect(challenge.protectedTotpSecret, challenge.userId);
    const step = this.totp.matchingStep(secret, totpCode);
    if (step === null) throw new MfaAuthenticationFailedError();
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    const enrolledAt = new Date();

    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.user.updateMany({
        where: {
          id: challenge.userId,
          status: AccountStatus.ACTIVE,
          credentialVersion: challenge.credentialVersion,
          totpEnrolledAt: null,
          userRoles: { some: { role: { in: [...STAFF_ROLES] } } },
        },
        data: {
          totpSecretCiphertext: challenge.protectedTotpSecret,
          totpEnrolledAt: enrolledAt,
          totpLastUsedStep: step,
          credentialVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new MfaAuthenticationFailedError();
      await transaction.mfaRecoveryCode.createMany({
        data: codes.map((code) => ({
          id: randomUUID(),
          userId: challenge.userId,
          codeHash: recoveryHash(code),
        })),
      });
    });

    try {
      await this.challenges.revoke(challengeToken);
    } catch (error) {
      if (!(error instanceof MfaServiceUnavailableError)) throw error;
      this.logger.warn('MFA enrollment challenge cleanup was deferred after enrollment.');
    }
    return { status: 'MFA_ENROLLED' as const, recoveryCodes: codes };
  }

  async authenticate(
    challengeToken: string,
    input: { totpCode?: string; recoveryCode?: string },
  ): Promise<AuthenticatedPrincipal> {
    const challenge = await this.readChallenge(challengeToken, 'AUTHENTICATION');
    if ((input.totpCode === undefined) === (input.recoveryCode === undefined)) {
      throw new MfaAuthenticationFailedError();
    }
    if (input.recoveryCode !== undefined && !RECOVERY_CODE_PATTERN.test(input.recoveryCode)) {
      throw new MfaAuthenticationFailedError();
    }
    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
      select: {
        id: true,
        emailNormalized: true,
        status: true,
        credentialVersion: true,
        totpSecretCiphertext: true,
        totpEnrolledAt: true,
        totpLastUsedStep: true,
        userRoles: { select: { role: true } },
      },
    });
    if (
      !user ||
      user.status !== AccountStatus.ACTIVE ||
      user.credentialVersion !== challenge.credentialVersion ||
      !user.totpSecretCiphertext ||
      !user.totpEnrolledAt ||
      !requiresStaffMfa(user.userRoles.map(({ role }) => role))
    )
      throw new MfaAuthenticationFailedError();

    if (input.totpCode !== undefined) {
      const step = this.totp.matchingStep(
        this.unprotect(user.totpSecretCiphertext, user.id),
        input.totpCode,
      );
      if (step === null) throw new MfaAuthenticationFailedError();
      const updated = await this.prisma.user.updateMany({
        where: {
          id: user.id,
          status: AccountStatus.ACTIVE,
          credentialVersion: challenge.credentialVersion,
          totpEnrolledAt: { not: null },
          userRoles: { some: { role: { in: [...STAFF_ROLES] } } },
          OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }],
        },
        data: { totpLastUsedStep: step },
      });
      if (updated.count !== 1) throw new MfaAuthenticationFailedError();
    } else {
      const used = await this.prisma.mfaRecoveryCode.updateMany({
        where: {
          userId: user.id,
          codeHash: recoveryHash(input.recoveryCode!),
          usedAt: null,
          user: {
            is: {
              status: AccountStatus.ACTIVE,
              credentialVersion: challenge.credentialVersion,
              totpEnrolledAt: { not: null },
              userRoles: { some: { role: { in: [...STAFF_ROLES] } } },
            },
          },
        },
        data: { usedAt: new Date() },
      });
      if (used.count !== 1) throw new MfaAuthenticationFailedError();
    }

    await this.challenges.revoke(challengeToken);
    return {
      id: user.id,
      email: user.emailNormalized,
      roles: user.userRoles.map(({ role }) => role),
      credentialVersion: user.credentialVersion,
      mfaEnrolled: true,
    };
  }

  async reauthenticate(
    userId: string,
    input: { password: string; totpCode?: string; recoveryCode?: string },
  ): Promise<AuthenticatedPrincipal> {
    if ((input.totpCode === undefined) === (input.recoveryCode === undefined)) {
      throw new MfaAuthenticationFailedError();
    }
    if (input.recoveryCode !== undefined && !RECOVERY_CODE_PATTERN.test(input.recoveryCode)) {
      throw new MfaAuthenticationFailedError();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        emailNormalized: true,
        passwordHash: true,
        status: true,
        credentialVersion: true,
        totpSecretCiphertext: true,
        totpEnrolledAt: true,
        totpLastUsedStep: true,
        userRoles: { select: { role: true } },
      },
    });
    const roles = user?.userRoles.map(({ role }) => role) ?? [];
    if (
      !user ||
      user.status !== AccountStatus.ACTIVE ||
      !user.totpSecretCiphertext ||
      !user.totpEnrolledAt ||
      !requiresStaffMfa(roles)
    ) {
      throw new MfaAuthenticationFailedError();
    }

    let passwordValid = false;
    try {
      passwordValid = await this.passwords.verify(input.password, user.passwordHash);
    } catch {
      passwordValid = false;
    }
    if (!passwordValid) throw new MfaAuthenticationFailedError();

    if (input.totpCode !== undefined) {
      const step = this.totp.matchingStep(
        this.unprotect(user.totpSecretCiphertext, user.id),
        input.totpCode,
      );
      if (step === null) throw new MfaAuthenticationFailedError();
      const updated = await this.prisma.user.updateMany({
        where: {
          id: user.id,
          status: AccountStatus.ACTIVE,
          credentialVersion: user.credentialVersion,
          totpEnrolledAt: { not: null },
          userRoles: { some: { role: { in: [...STAFF_ROLES] } } },
          OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }],
        },
        data: { totpLastUsedStep: step },
      });
      if (updated.count !== 1) throw new MfaAuthenticationFailedError();
    } else {
      const used = await this.prisma.mfaRecoveryCode.updateMany({
        where: {
          userId: user.id,
          codeHash: recoveryHash(input.recoveryCode!),
          usedAt: null,
          user: {
            is: {
              status: AccountStatus.ACTIVE,
              credentialVersion: user.credentialVersion,
              totpEnrolledAt: { not: null },
              userRoles: { some: { role: { in: [...STAFF_ROLES] } } },
            },
          },
        },
        data: { usedAt: new Date() },
      });
      if (used.count !== 1) throw new MfaAuthenticationFailedError();
    }

    return {
      id: user.id,
      email: user.emailNormalized,
      roles,
      credentialVersion: user.credentialVersion,
      mfaEnrolled: true,
    };
  }

  private async readChallenge(token: string, purpose: MfaChallengePurpose) {
    const challenge = await this.challenges.read(token);
    if (!challenge || challenge.purpose !== purpose) throw new MfaAuthenticationFailedError();
    return challenge;
  }

  private unprotect(encoded: string, userId: string): string {
    try {
      return this.protector.unprotect(encoded, userId);
    } catch {
      throw new MfaAuthenticationFailedError();
    }
  }
}
