import { PrismaService } from '../database/prisma.service';
import { AccountStatus } from '../generated/prisma/enums';
import {
  EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
  EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EmailVerificationRequestService,
} from './email-verification-request.service';

describe('EmailVerificationRequestService', () => {
  const now = new Date('2026-09-02T15:00:00.000Z');
  const userId = '6d6eb274-3885-474d-b3c3-09845a1d0f3f';

  function createSubject(options: { userExists?: boolean; claimed?: boolean } = {}) {
    const findUser = jest
      .fn()
      .mockResolvedValue(options.userExists === false ? null : { id: userId });
    const updateUser = jest.fn().mockResolvedValue({ count: options.claimed === false ? 0 : 1 });
    const createOutbox = jest.fn().mockResolvedValue({ id: 'outbox-id' });
    const transaction = {
      user: { findUnique: findUser, updateMany: updateUser },
      outboxMessage: { create: createOutbox },
    };
    const runTransaction = jest
      .fn()
      .mockImplementation((operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
      );
    const prisma = { $transaction: runTransaction } as unknown as PrismaService;

    return {
      service: new EmailVerificationRequestService(prisma),
      findUser,
      updateUser,
      createOutbox,
      runTransaction,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('normalizes the identifier and atomically creates a secret-free resend event', async () => {
    const { service, findUser, updateUser, createOutbox, runTransaction } = createSubject();

    await service.request('  CUSTOMER@Example.Test  ', {
      correlationId: 'request-12345678',
      causationId: 'command-12345678',
    });

    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(findUser).toHaveBeenCalledWith({
      where: { emailNormalized: 'customer@example.test' },
      select: { id: true },
    });
    expect(updateUser).toHaveBeenCalledWith({
      where: {
        id: userId,
        status: AccountStatus.PENDING_VERIFICATION,
        OR: [
          { verificationEmailRequestedAt: null },
          {
            verificationEmailRequestedAt: {
              lte: new Date(now.getTime() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MS),
            },
          },
        ],
      },
      data: { verificationEmailRequestedAt: now },
    });
    expect(createOutbox).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        eventType: EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
        eventVersion: EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
        aggregateType: 'User',
        aggregateId: userId,
        payload: { userId },
        correlationId: 'request-12345678',
        causationId: 'command-12345678',
      },
    });
    expect(JSON.stringify(createOutbox.mock.calls)).not.toContain('customer@example.test');
  });

  it('returns the same no-op when the account does not exist', async () => {
    const { service, updateUser, createOutbox } = createSubject({ userExists: false });

    await expect(service.request('missing@example.test')).resolves.toBeUndefined();

    expect(updateUser).not.toHaveBeenCalled();
    expect(createOutbox).not.toHaveBeenCalled();
  });

  it('creates no event when account state or cooldown makes the claim ineligible', async () => {
    const { service, updateUser, createOutbox } = createSubject({ claimed: false });

    await expect(service.request('customer@example.test')).resolves.toBeUndefined();

    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(createOutbox).not.toHaveBeenCalled();
  });

  it('does not hide an outbox failure behind the generic public result', async () => {
    const { service, createOutbox } = createSubject();
    createOutbox.mockRejectedValueOnce(new Error('Outbox unavailable'));

    await expect(service.request('customer@example.test')).rejects.toThrow('Outbox unavailable');
  });
});
