import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus } from '../generated/prisma/enums';
import { PasswordHasher } from './password-hasher.service';
import { PasswordPolicyError } from './password-policy';
import {
  InvalidPasswordResetTokenError,
  PASSWORD_RESET_TOKEN_TTL_MS,
  PasswordResetTokenService,
} from './password-reset-token.service';

describe('PasswordResetTokenService', () => {
  const now = new Date('2026-09-02T19:00:00.000Z');
  const token = Buffer.alloc(32, 7).toString('base64url');
  const userId = '6d6eb274-3885-474d-b3c3-09845a1d0f3f';
  const storedToken = {
    id: '28eb7eb5-52d3-4352-afc4-791ba5d96c1b',
    userId,
    expiresAt: new Date('2026-09-02T20:00:00.000Z'),
    consumedAt: null,
    revokedAt: null,
    user: {
      emailNormalized: 'customer@example.test',
      passwordHash: '$argon2id$current-hash',
      credentialVersion: 4,
      status: AccountStatus.ACTIVE,
    },
  };

  function createSubject() {
    const createToken = jest.fn().mockResolvedValue({ id: storedToken.id });
    const findToken = jest.fn().mockResolvedValue(storedToken);
    const claimToken = jest.fn().mockResolvedValue({ count: 1 });
    const updateUser = jest.fn().mockResolvedValue({ count: 1 });
    const revokeTokens = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      passwordResetToken: { updateMany: claimToken },
      user: { updateMany: updateUser },
    };
    transaction.passwordResetToken.updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const runTransaction = jest
      .fn()
      .mockImplementation((operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
      );
    const verify = jest.fn().mockResolvedValue(false);
    const hash = jest.fn().mockResolvedValue('$argon2id$new-hash');
    const prisma = {
      passwordResetToken: { create: createToken, findUnique: findToken },
      $transaction: runTransaction,
    } as unknown as PrismaService;
    const hasher = { verify, hash } as unknown as PasswordHasher;

    return {
      service: new PasswordResetTokenService(prisma, hasher),
      createToken,
      findToken,
      claimToken: transaction.passwordResetToken.updateMany,
      updateUser,
      revokeTokens,
      runTransaction,
      verify,
      hash,
    };
  }

  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('stores only a digest when issuing a one-hour reset credential', async () => {
    const { service, createToken } = createSubject();
    const issued = await service.issue(userId);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toEqual(new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS));
    expect(createToken).toHaveBeenCalledWith({
      data: {
        userId,
        tokenHash: createHash('sha256').update(issued.token, 'utf8').digest('hex'),
        expiresAt: issued.expiresAt,
      },
    });
    expect(JSON.stringify(createToken.mock.calls)).not.toContain(issued.token);
  });

  it('hashes outside the transaction and atomically consumes, updates, and revokes', async () => {
    const { service, verify, hash, claimToken, updateUser, runTransaction } = createSubject();

    await expect(service.reset(token, 'a-brand-new-password')).resolves.toEqual({
      userId,
      credentialVersion: 5,
    });

    expect(verify).toHaveBeenCalledWith('a-brand-new-password', '$argon2id$current-hash');
    expect(hash).toHaveBeenCalledWith('a-brand-new-password');
    expect(hash.mock.invocationCallOrder[0]).toBeLessThan(
      runTransaction.mock.invocationCallOrder[0],
    );
    expect(claimToken).toHaveBeenNthCalledWith(1, {
      where: {
        id: storedToken.id,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    expect(updateUser).toHaveBeenCalledWith({
      where: { id: userId, status: AccountStatus.ACTIVE, credentialVersion: 4 },
      data: { passwordHash: '$argon2id$new-hash', credentialVersion: { increment: 1 } },
    });
    expect(claimToken).toHaveBeenNthCalledWith(2, {
      where: {
        userId,
        id: { not: storedToken.id },
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
  });

  it('rejects the current password before hashing or opening a transaction', async () => {
    const { service, verify, hash, runTransaction } = createSubject();
    verify.mockResolvedValueOnce(true);

    await expect(service.reset(token, 'a-brand-new-password')).rejects.toEqual(
      new PasswordPolicyError('PASSWORD_REUSE_NOT_ALLOWED'),
    );
    expect(hash).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects malformed and unavailable credentials through one error', async () => {
    const { service, findToken } = createSubject();
    await expect(service.reset('malformed', 'a-brand-new-password')).rejects.toEqual(
      new InvalidPasswordResetTokenError(),
    );
    findToken.mockResolvedValueOnce(null);
    await expect(service.reset(token, 'a-brand-new-password')).rejects.toEqual(
      new InvalidPasswordResetTokenError(),
    );
  });

  it('applies basic password policy before credential lookup', async () => {
    const { service, findToken } = createSubject();
    await expect(service.reset('malformed', 'too-short')).rejects.toMatchObject({
      code: 'PASSWORD_TOO_SHORT',
    });
    expect(findToken).not.toHaveBeenCalled();
  });

  it('rolls back when a concurrent reset already consumed or revoked the token', async () => {
    const { service, claimToken, updateUser } = createSubject();
    claimToken.mockReset().mockResolvedValueOnce({ count: 0 });

    await expect(service.reset(token, 'a-brand-new-password')).rejects.toEqual(
      new InvalidPasswordResetTokenError(),
    );
    expect(updateUser).not.toHaveBeenCalled();
  });
});
