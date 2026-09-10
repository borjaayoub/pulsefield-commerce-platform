import Redis from 'ioredis';
import * as OTPAuth from 'otpauth';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { CredentialAuthenticationService } from './credential-authentication.service';
import { MfaChallengeStore } from './mfa-challenge.store';
import { MfaService } from './mfa.service';
import { PasswordHasher } from './password-hasher.service';
import { RedisSessionStore } from './redis-session.store';
import { SessionService } from './session.service';
import { TotpSecretProtector } from './totp-secret-protector.service';
import { TOTP_PERIOD_SECONDS, TotpService } from './totp.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ephemeralRedisUrl = process.env.EPHEMERAL_REDIS_URL;

if (!testDatabaseUrl || !ephemeralRedisUrl) {
  throw new Error(
    'TEST_DATABASE_URL and EPHEMERAL_REDIS_URL are required. Run this suite through pnpm test:integration.',
  );
}

describe('staff TOTP MFA integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const redis = new Redis(ephemeralRedisUrl, { maxRetriesPerRequest: 1 });
  const passwordHasher = new PasswordHasher();
  const credentials = new CredentialAuthenticationService(prisma, passwordHasher);
  const challenges = new MfaChallengeStore(ephemeralRedisUrl);
  const totp = new TotpService();
  const protector = new TotpSecretProtector({
    current: Buffer.alloc(32, 11).toString('base64'),
  });
  const mfa = new MfaService(prisma, challenges, totp, protector, passwordHasher);
  const sessionStore = new RedisSessionStore(ephemeralRedisUrl);
  const sessions = new SessionService(sessionStore, prisma);
  const userIds = new Set<string>();
  const challengeTokens = new Set<string>();
  const sessionIds = new Set<string>();

  function currentCode(secret: string): string {
    return new OTPAuth.TOTP({
      issuer: 'PULSE//FIELD',
      label: 'verification',
      algorithm: 'SHA1',
      digits: 6,
      period: TOTP_PERIOD_SECONDS,
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate();
  }

  async function createStaff() {
    const plainPassword = `staff-integration-password-${randomUUID()}`;
    const user = await prisma.user.create({
      data: {
        emailNormalized: `staff-${randomUUID()}@example.test`,
        passwordHash: await passwordHasher.hash(plainPassword),
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date(),
        userRoles: { create: { role: RoleName.FULFILLER } },
      },
    });
    userIds.add(user.id);
    return { user, plainPassword };
  }

  async function beginAndTrack(principal: Awaited<ReturnType<typeof credentials.authenticate>>) {
    const result = await mfa.begin(principal);
    challengeTokens.add(result.challengeToken);
    return result;
  }

  afterEach(async () => {
    for (const token of challengeTokens) {
      await redis.del(
        `pulse-field:mfa-challenge:${createHash('sha256').update(token).digest('hex')}`,
      );
    }
    challengeTokens.clear();
    for (const sessionId of sessionIds) {
      await redis.del(
        `pulse-field:session:${createHash('sha256').update(sessionId).digest('hex')}`,
      );
    }
    sessionIds.clear();
    const ids = [...userIds];
    if (ids.length > 0) {
      await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    userIds.clear();
  });

  afterAll(async () => {
    challenges.onApplicationShutdown();
    sessionStore.onApplicationShutdown();
    redis.disconnect(false);
    await prisma.$disconnect();
  });

  it('enrolls staff securely and prevents concurrent TOTP and recovery-code replay', async () => {
    const { user, plainPassword } = await createStaff();
    const passwordPrincipal = await credentials.authenticate(user.emailNormalized, plainPassword);
    expect(passwordPrincipal).toMatchObject({ mfaEnrolled: false, credentialVersion: 1 });

    const enrollment = await beginAndTrack(passwordPrincipal);
    expect(enrollment.status).toBe('MFA_ENROLLMENT_REQUIRED');
    if (enrollment.status !== 'MFA_ENROLLMENT_REQUIRED') throw new Error('Unexpected challenge.');
    const enrollmentCode = currentCode(enrollment.sharedSecret);
    const completed = await mfa.enroll(enrollment.challengeToken, enrollmentCode);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const recoveryRows = await prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(stored).toMatchObject({ credentialVersion: 2 });
    expect(stored.totpEnrolledAt).not.toBeNull();
    expect(stored.totpSecretCiphertext).not.toBeNull();
    expect(stored.totpSecretCiphertext).not.toContain(enrollment.sharedSecret);
    expect(protector.unprotect(stored.totpSecretCiphertext!, user.id)).toBe(
      enrollment.sharedSecret,
    );
    expect(recoveryRows).toHaveLength(10);
    expect(recoveryRows.every(({ codeHash }) => /^[a-f0-9]{64}$/.test(codeHash))).toBe(true);
    expect(JSON.stringify(recoveryRows)).not.toContain(completed.recoveryCodes[0]!);

    const enrolledPrincipal = await credentials.authenticate(user.emailNormalized, plainPassword);
    expect(enrolledPrincipal).toMatchObject({ mfaEnrolled: true, credentialVersion: 2 });

    await expect(
      mfa.reauthenticate(user.id, { password: 'not-the-password', totpCode: '123456' }),
    ).rejects.toMatchObject({ code: 'MFA_AUTHENTICATION_FAILED' });

    await prisma.user.update({ where: { id: user.id }, data: { totpLastUsedStep: null } });
    const preReauthenticationSession = await sessions.create(enrolledPrincipal, 'PASSWORD_MFA');
    sessionIds.add(preReauthenticationSession.sessionId);
    const reauthenticatedPrincipal = await mfa.reauthenticate(user.id, {
      password: plainPassword,
      totpCode: currentCode(enrollment.sharedSecret),
    });
    const replacementSession = await sessions.create(
      reauthenticatedPrincipal,
      'PASSWORD_MFA',
      preReauthenticationSession.sessionId,
    );
    sessionIds.add(replacementSession.sessionId);
    await expect(sessionStore.peek(preReauthenticationSession.sessionId)).resolves.toBeNull();
    await expect(sessions.current(replacementSession.sessionId)).resolves.toMatchObject({
      user: { id: user.id, roles: [RoleName.FULFILLER] },
    });

    await prisma.user.update({ where: { id: user.id }, data: { totpLastUsedStep: null } });
    const firstTotpChallenge = await beginAndTrack(enrolledPrincipal);
    const secondTotpChallenge = await beginAndTrack(enrolledPrincipal);
    const totpCode = currentCode(enrollment.sharedSecret);
    const totpResults = await Promise.allSettled([
      mfa.authenticate(firstTotpChallenge.challengeToken, { totpCode }),
      mfa.authenticate(secondTotpChallenge.challengeToken, { totpCode }),
    ]);
    expect(totpResults.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(totpResults.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const successfulTotp = totpResults.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof mfa.authenticate>>> =>
        result.status === 'fulfilled',
    );
    if (!successfulTotp) throw new Error('Expected one successful TOTP authentication.');
    const session = await sessions.create(successfulTotp.value, 'PASSWORD_MFA');
    sessionIds.add(session.sessionId);
    await expect(sessions.current(session.sessionId)).resolves.toMatchObject({
      user: { id: user.id, roles: [RoleName.FULFILLER] },
    });

    const firstRecoveryChallenge = await beginAndTrack(enrolledPrincipal);
    const secondRecoveryChallenge = await beginAndTrack(enrolledPrincipal);
    const recoveryCode = completed.recoveryCodes[0]!;
    const recoveryResults = await Promise.allSettled([
      mfa.authenticate(firstRecoveryChallenge.challengeToken, { recoveryCode }),
      mfa.authenticate(secondRecoveryChallenge.challengeToken, { recoveryCode }),
    ]);
    expect(recoveryResults.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(recoveryResults.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    await expect(
      prisma.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: { not: null } } }),
    ).resolves.toBe(1);

    const staleChallenge = await beginAndTrack(enrolledPrincipal);
    await prisma.user.update({
      where: { id: user.id },
      data: { credentialVersion: { increment: 1 } },
    });
    await expect(
      mfa.authenticate(staleChallenge.challengeToken, {
        recoveryCode: completed.recoveryCodes[1]!,
      }),
    ).rejects.toMatchObject({ code: 'MFA_AUTHENTICATION_FAILED' });
  });
});
