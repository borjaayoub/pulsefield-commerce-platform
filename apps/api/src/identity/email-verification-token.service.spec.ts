import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus } from '../generated/prisma/enums';
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  EmailVerificationTokenService,
  InvalidEmailVerificationTokenError,
} from './email-verification-token.service';

describe('EmailVerificationTokenService', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');
  const userId = 'f3aa0ff3-7da2-462f-a5a9-c82cb8402c59';
  const tokenId = '9dd33ac7-12d7-420b-9008-b854f57bf957';
  const token = Buffer.alloc(32, 7).toString('base64url');
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

  function createSubject(): {
    service: EmailVerificationTokenService;
    createToken: jest.Mock<Promise<{ id: string }>, [unknown]>;
    findToken: jest.Mock<Promise<{ id: string; userId: string } | null>, [unknown]>;
    updateToken: jest.Mock<Promise<{ count: number }>, [unknown]>;
    updateUser: jest.Mock<Promise<{ count: number }>, [unknown]>;
    runTransaction: jest.Mock<Promise<unknown>, [(transaction: unknown) => Promise<unknown>]>;
  } {
    const createToken = jest.fn<Promise<{ id: string }>, [unknown]>();
    const findToken = jest.fn<Promise<{ id: string; userId: string } | null>, [unknown]>();
    const updateToken = jest.fn<Promise<{ count: number }>, [unknown]>();
    const updateUser = jest.fn<Promise<{ count: number }>, [unknown]>();
    const transaction = {
      emailVerificationToken: {
        findUnique: findToken,
        updateMany: updateToken,
      },
      user: { updateMany: updateUser },
    };
    const runTransaction = jest.fn<Promise<unknown>, [(transaction: unknown) => Promise<unknown>]>(
      (operation) => operation(transaction),
    );
    const prisma = {
      emailVerificationToken: { create: createToken },
      $transaction: runTransaction,
    } as unknown as PrismaService;

    createToken.mockResolvedValue({ id: tokenId });
    findToken.mockResolvedValue({ id: tokenId, userId });
    updateToken.mockResolvedValue({ count: 1 });
    updateUser.mockResolvedValue({ count: 1 });

    return {
      service: new EmailVerificationTokenService(prisma),
      createToken,
      findToken,
      updateToken,
      updateUser,
      runTransaction,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('issues a random URL-safe token while storing only its digest', async () => {
    // Arrange
    const { service, createToken } = createSubject();

    // Act
    const issued = await service.issue(userId);

    // Assert
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toEqual(new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS));
    expect(createToken).toHaveBeenCalledWith({
      data: {
        userId,
        tokenHash: createHash('sha256').update(issued.token, 'utf8').digest('hex'),
        expiresAt: issued.expiresAt,
      },
    });
    expect(JSON.stringify(createToken.mock.calls)).not.toContain(issued.token);
  });

  it('atomically consumes a valid token, activates the user, and revokes sibling tokens', async () => {
    // Arrange
    const { service, findToken, updateToken, updateUser, runTransaction } = createSubject();

    // Act
    const result = await service.consume(token);

    // Assert
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(findToken).toHaveBeenCalledWith({
      where: { tokenHash },
      select: { id: true, userId: true },
    });
    expect(updateToken).toHaveBeenNthCalledWith(1, {
      where: {
        id: tokenId,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    expect(updateUser).toHaveBeenCalledWith({
      where: { id: userId, status: AccountStatus.PENDING_VERIFICATION },
      data: { status: AccountStatus.ACTIVE, verifiedAt: now },
    });
    expect(updateToken).toHaveBeenNthCalledWith(2, {
      where: {
        userId,
        id: { not: tokenId },
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    expect(result).toEqual({ userId, verifiedAt: now });
  });

  it('rejects malformed tokens before opening a transaction', async () => {
    // Arrange
    const { service, runTransaction } = createSubject();

    // Act and Assert
    await expect(service.consume('malformed-token')).rejects.toMatchObject({
      code: 'INVALID_EMAIL_VERIFICATION_TOKEN',
    });
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('returns the same safe error when a token is missing, expired, revoked, or already consumed', async () => {
    // Arrange
    const { service, findToken, updateToken, updateUser } = createSubject();
    findToken.mockResolvedValueOnce(null);

    // Act and Assert
    await expect(service.consume(token)).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);

    findToken.mockResolvedValueOnce({ id: tokenId, userId });
    updateToken.mockResolvedValueOnce({ count: 0 });
    await expect(service.consume(token)).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('does not activate suspended or already-active accounts', async () => {
    // Arrange
    const { service, updateUser, updateToken } = createSubject();
    updateUser.mockResolvedValueOnce({ count: 0 });

    // Act and Assert
    await expect(service.consume(token)).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);
    expect(updateToken).toHaveBeenCalledTimes(1);
  });

  it('never includes the submitted token in its error message', async () => {
    // Arrange
    const { service, findToken } = createSubject();
    findToken.mockResolvedValueOnce(null);

    // Act and Assert
    await expect(service.consume(token)).rejects.not.toThrow(token);
  });
});
