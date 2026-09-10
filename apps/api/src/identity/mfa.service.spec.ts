import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { MfaAuthenticationFailedError } from './authentication.errors';
import type { AuthenticatedPrincipal } from './credential-authentication.service';
import { requiresStaffMfa } from './authorization.service';
import type { MfaChallengeRecord } from './mfa-challenge.store';
import { MfaService } from './mfa.service';

describe('MfaService', () => {
  const userId = '67b3456e-5303-41e7-9c36-4611ee204811';
  const token = Buffer.alloc(32, 4).toString('base64url');
  const principal: AuthenticatedPrincipal = {
    id: userId,
    email: 'staff@example.test',
    roles: [RoleName.FULFILLER],
    credentialVersion: 3,
    mfaEnrolled: false,
  };

  function createSubject() {
    const userUpdateMany = jest.fn(async () => ({ count: 1 }));
    const recoveryCreateMany = jest.fn<
      Promise<{ count: number }>,
      [{ data: Array<{ id: string; userId: string; codeHash: string }> }]
    >(async () => ({ count: 10 }));
    const recoveryUpdateMany = jest.fn(async () => ({ count: 1 }));
    const findUnique = jest.fn(async () => ({
      id: userId,
      emailNormalized: principal.email,
      passwordHash: '$argon2id$test-hash',
      status: AccountStatus.ACTIVE as AccountStatus,
      credentialVersion: 3,
      totpSecretCiphertext: 'protected-secret',
      totpEnrolledAt: new Date(),
      totpLastUsedStep: 100n,
      userRoles: [{ role: RoleName.FULFILLER }],
    }));
    const transaction = {
      user: { updateMany: userUpdateMany },
      mfaRecoveryCode: { createMany: recoveryCreateMany },
    };
    const runTransaction = jest.fn(async (work: (client: typeof transaction) => Promise<void>) =>
      work(transaction),
    );
    const prisma = {
      user: { findUnique, updateMany: userUpdateMany },
      mfaRecoveryCode: { updateMany: recoveryUpdateMany },
      $transaction: runTransaction,
    };
    const createChallenge = jest.fn(async (input: Record<string, unknown>) => ({
      token,
      record: { version: 1, ...input, expiresAt: Date.now() + 300_000 },
    }));
    const readChallenge = jest.fn<Promise<MfaChallengeRecord | null>, [string]>(async () => ({
      version: 1,
      purpose: 'AUTHENTICATION',
      userId,
      credentialVersion: 3,
      expiresAt: Date.now() + 300_000,
    }));
    const revokeChallenge = jest.fn(async () => undefined);
    const challenges = {
      create: createChallenge,
      read: readChallenge,
      revoke: revokeChallenge,
    };
    const createTotp = jest.fn(() => ({
      secret: 'JBSWY3DPEHPK3PXP',
      provisioningUri: 'otpauth://totp/PULSE%2F%2FFIELD:staff',
    }));
    const matchingStep = jest.fn(() => 101n as bigint | null);
    const totp = { create: createTotp, matchingStep };
    const protect = jest.fn(() => 'protected-secret');
    const unprotect = jest.fn(() => 'JBSWY3DPEHPK3PXP');
    const protector = { protect, unprotect };
    const verifyPassword = jest.fn(async () => true);
    const service = new MfaService(
      prisma as never,
      challenges as never,
      totp as never,
      protector as never,
      { verify: verifyPassword } as never,
    );
    return {
      service,
      userUpdateMany,
      recoveryCreateMany,
      recoveryUpdateMany,
      findUnique,
      createChallenge,
      readChallenge,
      revokeChallenge,
      createTotp,
      matchingStep,
      protect,
      unprotect,
      verifyPassword,
    };
  }

  it('classifies only privileged staff roles as requiring MFA', () => {
    expect(requiresStaffMfa([RoleName.CUSTOMER])).toBe(false);
    expect(requiresStaffMfa([RoleName.FULFILLER])).toBe(true);
    expect(requiresStaffMfa([RoleName.ADMINISTRATOR])).toBe(true);
  });

  it('starts enrollment for an unenrolled staff account without persisting plaintext', async () => {
    const { service, createChallenge, createTotp, protect } = createSubject();

    await expect(service.begin(principal)).resolves.toMatchObject({
      status: 'MFA_ENROLLMENT_REQUIRED',
      challengeToken: token,
      sharedSecret: 'JBSWY3DPEHPK3PXP',
    });
    expect(createTotp).toHaveBeenCalledWith(principal.email);
    expect(protect).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP', userId);
    expect(createChallenge).toHaveBeenCalledWith({
      purpose: 'ENROLLMENT',
      userId,
      credentialVersion: 3,
      protectedTotpSecret: 'protected-secret',
    });
    expect(JSON.stringify(createChallenge.mock.calls)).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('starts authentication for enrolled staff and never issues a new secret', async () => {
    const { service, createChallenge, createTotp } = createSubject();

    await expect(service.begin({ ...principal, mfaEnrolled: true })).resolves.toMatchObject({
      status: 'MFA_REQUIRED',
      challengeToken: token,
    });
    expect(createChallenge).toHaveBeenCalledWith({
      purpose: 'AUTHENTICATION',
      userId,
      credentialVersion: 3,
    });
    expect(createTotp).not.toHaveBeenCalled();
  });

  it('rejects attempts to begin staff MFA for a customer', async () => {
    const { service, createChallenge } = createSubject();

    await expect(service.begin({ ...principal, roles: [RoleName.CUSTOMER] })).rejects.toEqual(
      new MfaAuthenticationFailedError(),
    );
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it('enrolls atomically, increments the credential version, and returns one-time recovery codes', async () => {
    const { service, readChallenge, userUpdateMany, recoveryCreateMany, revokeChallenge } =
      createSubject();
    readChallenge.mockResolvedValueOnce({
      version: 1,
      purpose: 'ENROLLMENT',
      userId,
      credentialVersion: 3,
      protectedTotpSecret: 'protected-secret',
      expiresAt: Date.now() + 300_000,
    });

    const result = await service.enroll(token, '123456');

    expect(result.status).toBe('MFA_ENROLLED');
    expect(result.recoveryCodes).toHaveLength(10);
    expect(new Set(result.recoveryCodes)).toHaveProperty('size', 10);
    expect(result.recoveryCodes.every((code) => /^[A-F0-9]{5}(-[A-F0-9]{5}){3}$/.test(code))).toBe(
      true,
    );
    expect(userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: userId,
          status: AccountStatus.ACTIVE,
          credentialVersion: 3,
          totpEnrolledAt: null,
        }),
        data: expect.objectContaining({
          totpSecretCiphertext: 'protected-secret',
          totpLastUsedStep: 101n,
          credentialVersion: { increment: 1 },
        }),
      }),
    );
    const persisted = recoveryCreateMany.mock.calls[0]![0];
    expect(persisted.data).toHaveLength(10);
    expect(
      persisted.data.every(({ codeHash }: { codeHash: string }) => /^[a-f0-9]{64}$/.test(codeHash)),
    ).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain(result.recoveryCodes[0]!);
    expect(revokeChallenge).toHaveBeenCalledWith(token);
  });

  it('fails enrollment without recovery-code writes when the account precondition loses a race', async () => {
    const { service, readChallenge, userUpdateMany, recoveryCreateMany, revokeChallenge } =
      createSubject();
    readChallenge.mockResolvedValueOnce({
      version: 1,
      purpose: 'ENROLLMENT',
      userId,
      credentialVersion: 3,
      protectedTotpSecret: 'protected-secret',
      expiresAt: Date.now() + 300_000,
    });
    userUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.enroll(token, '123456')).rejects.toEqual(
      new MfaAuthenticationFailedError(),
    );
    expect(recoveryCreateMany).not.toHaveBeenCalled();
    expect(revokeChallenge).not.toHaveBeenCalled();
  });

  it('consumes a newer TOTP step once with active staff preconditions', async () => {
    const { service, userUpdateMany, revokeChallenge } = createSubject();

    await expect(service.authenticate(token, { totpCode: '123456' })).resolves.toMatchObject({
      id: userId,
      mfaEnrolled: true,
    });
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: userId,
        status: AccountStatus.ACTIVE,
        credentialVersion: 3,
        totpEnrolledAt: { not: null },
        OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: 101n } }],
      }),
      data: { totpLastUsedStep: 101n },
    });
    expect(revokeChallenge).toHaveBeenCalledWith(token);
  });

  it('rejects replay when another request already consumed the TOTP step', async () => {
    const { service, userUpdateMany, revokeChallenge } = createSubject();
    userUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.authenticate(token, { totpCode: '123456' })).rejects.toEqual(
      new MfaAuthenticationFailedError(),
    );
    expect(revokeChallenge).not.toHaveBeenCalled();
  });

  it('reauthenticates active staff with the current password and a fresh TOTP step', async () => {
    const { service, verifyPassword, userUpdateMany, matchingStep } = createSubject();

    await expect(
      service.reauthenticate(userId, {
        password: 'correct horse battery staple',
        totpCode: '123456',
      }),
    ).resolves.toMatchObject({
      id: userId,
      roles: [RoleName.FULFILLER],
      credentialVersion: 3,
      mfaEnrolled: true,
    });

    expect(verifyPassword).toHaveBeenCalledWith(
      'correct horse battery staple',
      '$argon2id$test-hash',
    );
    expect(matchingStep).toHaveBeenCalled();
    expect(userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { totpLastUsedStep: 101n } }),
    );
  });

  it('rejects a wrong reauthentication password before consuming the second factor', async () => {
    const { service, verifyPassword, userUpdateMany, matchingStep, recoveryUpdateMany } =
      createSubject();
    verifyPassword.mockResolvedValueOnce(false);

    await expect(
      service.reauthenticate(userId, { password: 'wrong password', totpCode: '123456' }),
    ).rejects.toEqual(new MfaAuthenticationFailedError());

    expect(matchingStep).not.toHaveBeenCalled();
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(recoveryUpdateMany).not.toHaveBeenCalled();
  });

  it('consumes an unused recovery code during staff reauthentication', async () => {
    const { service, recoveryUpdateMany } = createSubject();

    await expect(
      service.reauthenticate(userId, {
        password: 'correct horse battery staple',
        recoveryCode: 'AAAAA-BBBBB-CCCCC-DDDDD',
      }),
    ).resolves.toMatchObject({ id: userId, mfaEnrolled: true });

    expect(recoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usedAt: expect.any(Date) } }),
    );
  });

  it.each([
    ['a suspended account', AccountStatus.SUSPENDED, 3],
    ['a stale credential version', AccountStatus.ACTIVE, 4],
  ])(
    'rejects MFA authentication for %s before factor mutation',
    async (_label, status, version) => {
      const { service, findUnique, userUpdateMany, recoveryUpdateMany, revokeChallenge } =
        createSubject();
      findUnique.mockResolvedValueOnce({
        id: userId,
        emailNormalized: principal.email,
        passwordHash: '$argon2id$test-hash',
        status,
        credentialVersion: version,
        totpSecretCiphertext: 'protected-secret',
        totpEnrolledAt: new Date(),
        totpLastUsedStep: 100n,
        userRoles: [{ role: RoleName.FULFILLER }],
      });

      await expect(service.authenticate(token, { totpCode: '123456' })).rejects.toEqual(
        new MfaAuthenticationFailedError(),
      );
      expect(userUpdateMany).not.toHaveBeenCalled();
      expect(recoveryUpdateMany).not.toHaveBeenCalled();
      expect(revokeChallenge).not.toHaveBeenCalled();
    },
  );

  it('atomically consumes a recovery code and rejects malformed or ambiguous inputs', async () => {
    const { service, recoveryUpdateMany, findUnique } = createSubject();

    await expect(
      service.authenticate(token, { recoveryCode: 'ABCDE-12345-ABCDE-12345' }),
    ).resolves.toMatchObject({ id: userId });
    expect(recoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId, usedAt: null }),
      }),
    );

    findUnique.mockClear();
    await expect(service.authenticate(token, { recoveryCode: 'not-a-code' })).rejects.toEqual(
      new MfaAuthenticationFailedError(),
    );
    await expect(
      service.authenticate(token, {
        totpCode: '123456',
        recoveryCode: 'ABCDE-12345-ABCDE-12345',
      }),
    ).rejects.toEqual(new MfaAuthenticationFailedError());
    expect(findUnique).not.toHaveBeenCalled();
  });
});
