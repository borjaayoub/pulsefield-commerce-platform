import type { LocalProfile } from '@pulse-field/foundation';
import { decryptQueueMessage } from '@pulse-field/foundation';
import { PrismaService } from '../database/prisma.service';
import {
  AccountStatus,
  NotificationDeliveryType,
  OutboxMessageStatus,
} from '../generated/prisma/enums';
import {
  CUSTOMER_REGISTERED_EVENT_TYPE,
  CUSTOMER_REGISTERED_EVENT_VERSION,
} from '../identity/customer-registration.service';
import { EmailVerificationTokenService } from '../identity/email-verification-token.service';
import { PasswordResetTokenService } from '../identity/password-reset-token.service';
import {
  PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
  PASSWORD_RECOVERY_REQUEST_EVENT_VERSION,
} from '../identity/password-recovery-request.service';
import {
  EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
  EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
} from '../identity/email-verification-request.service';
import type { OutboxPublisher } from './bullmq-outbox.publisher';
import { calculateOutboxRetryDelayMs, OutboxRelayService } from './outbox-relay.service';

describe('OutboxRelayService', () => {
  const now = new Date('2026-09-01T20:00:00.000Z');
  const eventId = 'f62d69e7-0c86-4df8-b592-577815cb8461';
  const userId = '6d6eb274-3885-474d-b3c3-09845a1d0f3f';
  const encryptionKey = Buffer.alloc(32, 3).toString('base64');
  const profile = {
    OUTBOX_RELAY_ENABLED: false,
    WEB_ORIGIN: 'http://localhost:3000',
    MESSAGE_ENCRYPTION_KEY_BASE64: encryptionKey,
  } as LocalProfile;

  const message = {
    id: eventId,
    eventType: CUSTOMER_REGISTERED_EVENT_TYPE,
    eventVersion: CUSTOMER_REGISTERED_EVENT_VERSION,
    aggregateId: userId,
    payload: { userId },
    correlationId: 'request-12345678',
    attemptCount: 0,
  };

  function createSubject() {
    const findOutbox = jest.fn().mockResolvedValue(message);
    const updateOutbox = jest.fn().mockResolvedValue({ count: 1 });
    const findUser = jest.fn().mockResolvedValue({
      emailNormalized: 'customer@example.test',
      status: AccountStatus.PENDING_VERIFICATION,
    });
    const findOrder = jest.fn().mockResolvedValue(null);
    const issue = jest.fn().mockResolvedValue({
      token: 'raw-verification-token',
      expiresAt: new Date('2026-09-02T04:00:00.000Z'),
    });
    const publishEmailVerification = jest.fn().mockResolvedValue(undefined);
    const issuePasswordReset = jest.fn().mockResolvedValue({
      token: 'raw-password-reset-token',
      expiresAt: new Date('2026-09-01T21:00:00.000Z'),
    });
    const publishPasswordRecovery = jest.fn().mockResolvedValue(undefined);
    const publishOrderConfirmation = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      outboxMessage: { findFirst: findOutbox, updateMany: updateOutbox },
      user: { findUnique: findUser },
      order: { findUnique: findOrder },
    } as unknown as PrismaService;
    const tokens = { issue } as unknown as EmailVerificationTokenService;
    const passwordResetTokens = {
      issue: issuePasswordReset,
    } as unknown as PasswordResetTokenService;
    const publisher = {
      publishEmailVerification,
      publishPasswordRecovery,
      publishOrderConfirmation,
    } as OutboxPublisher;
    const recordQueued = jest.fn().mockResolvedValue(undefined);
    const deliveries = { recordQueued };

    return {
      service: new OutboxRelayService(
        prisma,
        tokens,
        passwordResetTokens,
        deliveries as never,
        publisher,
        profile,
      ),
      findOutbox,
      updateOutbox,
      findUser,
      issue,
      publishEmailVerification,
      issuePasswordReset,
      publishPasswordRecovery,
      publishOrderConfirmation,
      recordQueued,
      findOrder,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('claims one eligible event, encrypts delivery data, and marks it published', async () => {
    const { service, updateOutbox, issue, publishEmailVerification, recordQueued } =
      createSubject();

    await expect(service.drainOnce()).resolves.toBe(true);

    expect(issue).toHaveBeenCalledWith(userId);
    expect(recordQueued).toHaveBeenCalledWith({
      sourceEventId: eventId,
      userId,
      type: NotificationDeliveryType.EMAIL_VERIFICATION,
      correlationId: 'request-12345678',
    });
    expect(publishEmailVerification).toHaveBeenCalledTimes(1);
    const job = publishEmailVerification.mock.calls[0]?.[0];
    expect(job).toMatchObject({
      version: 1,
      sourceEventId: eventId,
      correlationId: 'request-12345678',
      userId,
    });
    expect(decryptQueueMessage(job.encryptedDelivery, encryptionKey)).toEqual({
      version: 1,
      recipient: 'customer@example.test',
      verificationUrl: 'http://localhost:3000/verify-email?token=raw-verification-token',
      expiresAt: '2026-09-02T04:00:00.000Z',
    });
    const serializedJob = JSON.stringify(job);
    expect(serializedJob).not.toContain('customer@example.test');
    expect(serializedJob).not.toContain('raw-verification-token');
    expect(updateOutbox).toHaveBeenLastCalledWith({
      where: {
        id: eventId,
        status: OutboxMessageStatus.PENDING,
        claimedBy: expect.any(String),
      },
      data: {
        status: OutboxMessageStatus.PUBLISHED,
        publishedAt: now,
        claimedAt: null,
        claimedBy: null,
        lastError: null,
      },
    });
  });

  it('routes a verification resend event through the existing encrypted job', async () => {
    const { service, findOutbox, issue, publishEmailVerification } = createSubject();
    findOutbox.mockResolvedValueOnce({
      ...message,
      eventType: EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
      eventVersion: EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
    });

    await service.drainOnce();

    expect(issue).toHaveBeenCalledWith(userId);
    expect(publishEmailVerification).toHaveBeenCalledTimes(1);
  });

  it('routes active-account recovery through its encrypted password-reset job', async () => {
    const {
      service,
      findOutbox,
      findUser,
      issue,
      issuePasswordReset,
      publishEmailVerification,
      publishPasswordRecovery,
      recordQueued,
    } = createSubject();
    findOutbox.mockResolvedValueOnce({
      ...message,
      eventType: PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
      eventVersion: PASSWORD_RECOVERY_REQUEST_EVENT_VERSION,
    });
    findUser.mockResolvedValueOnce({
      emailNormalized: 'customer@example.test',
      status: AccountStatus.ACTIVE,
    });

    await service.drainOnce();

    expect(issue).not.toHaveBeenCalled();
    expect(publishEmailVerification).not.toHaveBeenCalled();
    expect(issuePasswordReset).toHaveBeenCalledWith(userId);
    expect(recordQueued).toHaveBeenCalledWith({
      sourceEventId: eventId,
      userId,
      type: NotificationDeliveryType.PASSWORD_RECOVERY,
      correlationId: 'request-12345678',
    });
    const job = publishPasswordRecovery.mock.calls[0]?.[0];
    expect(decryptQueueMessage(job.encryptedDelivery, encryptionKey)).toEqual({
      version: 1,
      recipient: 'customer@example.test',
      passwordResetUrl: 'http://localhost:3000/reset-password?token=raw-password-reset-token',
      expiresAt: '2026-09-01T21:00:00.000Z',
    });
    expect(JSON.stringify(job)).not.toContain('customer@example.test');
    expect(JSON.stringify(job)).not.toContain('raw-password-reset-token');
  });

  it('encrypts confirmed-order recipient and guest access before publication', async () => {
    const { service, findOutbox, findOrder, publishOrderConfirmation, recordQueued } =
      createSubject();
    const orderId = '47bb642d-b99b-4fe0-b136-63f5e2fefadb';
    const grantId = 'cb995e40-e77e-48ce-b118-af88285f7e12';
    findOutbox.mockResolvedValueOnce({
      ...message,
      eventType: 'commerce.order.confirmed',
      eventVersion: 1,
      aggregateId: orderId,
      payload: { orderId, orderReference: 'PF-ABCDEF123456', outcome: 'confirmed' },
    });
    findOrder.mockResolvedValueOnce({
      reference: 'PF-ABCDEF123456',
      status: 'CONFIRMED',
      customerEmailNormalized: 'buyer@example.test',
      guestAccessGrant: {
        id: grantId,
        expiresAt: new Date('2026-10-01T20:00:00.000Z'),
        revokedAt: null,
      },
    });

    await service.drainOnce();

    expect(recordQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEventId: eventId,
        orderId,
        type: NotificationDeliveryType.ORDER_CONFIRMATION,
      }),
    );
    const job = publishOrderConfirmation.mock.calls[0]?.[0];
    expect(decryptQueueMessage(job.encryptedDelivery, encryptionKey)).toMatchObject({
      recipient: 'buyer@example.test',
      orderReference: 'PF-ABCDEF123456',
      orderTimelineUrl: expect.stringContaining('/orders/PF-ABCDEF123456#access='),
    });
    expect(JSON.stringify(job)).not.toContain('buyer@example.test');
    expect(JSON.stringify(job)).not.toContain('#access=');
  });

  it('does nothing when no event is eligible', async () => {
    const { service, findOutbox, updateOutbox, publishEmailVerification } = createSubject();
    findOutbox.mockResolvedValueOnce(null);

    await expect(service.drainOnce()).resolves.toBe(false);

    expect(updateOutbox).not.toHaveBeenCalled();
    expect(publishEmailVerification).not.toHaveBeenCalled();
  });

  it('claims only notification event types owned by this relay', async () => {
    const { service, findOutbox } = createSubject();
    findOutbox.mockResolvedValueOnce(null);

    await service.drainOnce();

    expect(findOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventType: {
            in: expect.arrayContaining([
              CUSTOMER_REGISTERED_EVENT_TYPE,
              EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
              PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
            ]),
          },
        }),
      }),
    );
  });

  it('releases a failed publication with bounded backoff and no raw error', async () => {
    const { service, updateOutbox, publishEmailVerification } = createSubject();
    publishEmailVerification.mockRejectedValueOnce(new Error('redis://user:secret@remote.example'));

    await service.drainOnce();

    expect(updateOutbox).toHaveBeenLastCalledWith({
      where: {
        id: eventId,
        status: OutboxMessageStatus.PENDING,
        claimedBy: expect.any(String),
      },
      data: {
        attemptCount: 1,
        lastError: 'QUEUE_PUBLICATION_FAILED',
        availableAt: expect.any(Date),
        claimedAt: null,
        claimedBy: null,
      },
    });
    expect(JSON.stringify(updateOutbox.mock.calls)).not.toContain('remote.example');
  });

  it('dead-letters malformed events without issuing a token', async () => {
    const { service, findOutbox, updateOutbox, issue, publishEmailVerification } = createSubject();
    findOutbox.mockResolvedValueOnce({ ...message, payload: { wrong: userId } });

    await service.drainOnce();

    expect(issue).not.toHaveBeenCalled();
    expect(publishEmailVerification).not.toHaveBeenCalled();
    expect(updateOutbox).toHaveBeenLastCalledWith({
      where: {
        id: eventId,
        status: OutboxMessageStatus.PENDING,
        claimedBy: expect.any(String),
      },
      data: {
        status: OutboxMessageStatus.DEAD_LETTER,
        attemptCount: { increment: 1 },
        lastError: 'INVALID_OUTBOX_PAYLOAD',
        deadLetteredAt: now,
        claimedAt: null,
        claimedBy: null,
      },
    });
  });

  it('dead-letters the eighth publication failure', async () => {
    const { service, findOutbox, updateOutbox, publishEmailVerification } = createSubject();
    findOutbox.mockResolvedValueOnce({ ...message, attemptCount: 7 });
    publishEmailVerification.mockRejectedValueOnce(new Error('Redis unavailable'));

    await service.drainOnce();

    expect(updateOutbox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: OutboxMessageStatus.DEAD_LETTER,
          lastError: 'QUEUE_PUBLICATION_FAILED',
        }),
      }),
    );
  });

  it('acknowledges an event without sending when the account is no longer pending', async () => {
    const { service, findUser, issue, publishEmailVerification, updateOutbox } = createSubject();
    findUser.mockResolvedValueOnce({
      emailNormalized: 'customer@example.test',
      status: AccountStatus.ACTIVE,
    });

    await service.drainOnce();

    expect(issue).not.toHaveBeenCalled();
    expect(publishEmailVerification).not.toHaveBeenCalled();
    expect(updateOutbox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OutboxMessageStatus.PUBLISHED }),
      }),
    );
  });

  it('caps retry delay and keeps jitter within the documented range', () => {
    expect(calculateOutboxRetryDelayMs(1, 0)).toBe(500);
    expect(calculateOutboxRetryDelayMs(1, 1)).toBe(1_500);
    expect(calculateOutboxRetryDelayMs(99, 1)).toBe(300_000);
  });
});
