import type { AuditedCommandContext } from '../audit/command-context';
import type { AuditService } from '../audit/audit.service';
import {
  AccountStatus,
  NotificationDeliveryStatus,
  NotificationDeliveryType,
  RoleName,
} from '../generated/prisma/enums';
import {
  ForbiddenError,
  NotificationDeliveryReplayUnavailableError,
} from './authentication.errors';
import {
  EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
  EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
} from './email-verification-request.service';
import { NotificationDeliveryReplayService } from './notification-delivery-replay.service';
import {
  PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
  PASSWORD_RECOVERY_REQUEST_EVENT_VERSION,
} from './password-recovery-request.service';

describe('NotificationDeliveryReplayService', () => {
  const actorId = '67b3456e-5303-41e7-9c36-4611ee204811';
  const deliveryId = '1c41ff8c-f6a9-4e8e-af74-2768909e20c4';
  const sourceEventId = 'b9b02496-4e96-4a69-9ee7-7e0d5abbe4d4';
  const userId = '88b424db-0ece-4746-8929-984543ef494c';

  function context(): AuditedCommandContext {
    return {
      requestId: 'request-notification-replay-123',
      correlationId: 'correlation-notification-replay-123',
      idempotencyKey: 'idempotency-notification-replay-123',
      actor: { type: 'staff', id: actorId, roles: [RoleName.ADMINISTRATOR] },
      reason: 'Retry a terminally failed identity notification',
    };
  }

  function createSubject(input?: {
    actor?: {
      status: AccountStatus;
      verifiedAt: Date | null;
      userRoles: { role: RoleName }[];
    } | null;
    delivery?: {
      id: string;
      sourceEventId: string;
      userId: string;
      type: NotificationDeliveryType;
      status: NotificationDeliveryStatus;
      replayedAt: Date | null;
      user: { status: AccountStatus };
    } | null;
    claimCount?: number;
  }) {
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce(
        input?.actor ?? {
          status: AccountStatus.ACTIVE,
          verifiedAt: new Date(),
          userRoles: [{ role: RoleName.ADMINISTRATOR }],
        },
      )
      .mockResolvedValueOnce(
        input?.delivery ?? {
          id: deliveryId,
          sourceEventId,
          userId,
          type: NotificationDeliveryType.PASSWORD_RECOVERY,
          status: NotificationDeliveryStatus.FAILED_TERMINAL,
          replayedAt: null,
          user: { status: AccountStatus.ACTIVE },
        },
      );
    const updateMany = jest.fn(async () => ({ count: input?.claimCount ?? 1 }));
    const create = jest.fn(async () => ({}));
    const transaction = {
      user: { findUnique },
      notificationDelivery: { findUnique, updateMany },
      outboxMessage: { create },
      auditRecord: { create: jest.fn(async () => ({})) },
    };
    const runTransaction = jest.fn(async (work: (writer: typeof transaction) => unknown) =>
      work(transaction),
    );
    const append = jest.fn(async () => ({}));
    const service = new NotificationDeliveryReplayService(
      { $transaction: runTransaction } as never,
      { append } as unknown as AuditService,
    );
    return { service, findUnique, updateMany, create, append, runTransaction };
  }

  it('marks a terminal recovery delivery once, creates a fresh secret-free event, and audits it', async () => {
    const { service, updateMany, create, append } = createSubject();

    const result = await service.replay(deliveryId, context());

    expect(result.deliveryId).toBe(deliveryId);
    expect(result.replayEventId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: deliveryId,
          status: NotificationDeliveryStatus.FAILED_TERMINAL,
          replayedAt: null,
        },
        data: expect.objectContaining({ replayedBy: actorId }),
      }),
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: result.replayEventId,
        eventType: PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
        eventVersion: PASSWORD_RECOVERY_REQUEST_EVENT_VERSION,
        aggregateType: 'User',
        aggregateId: userId,
        payload: { userId },
        correlationId: context().correlationId,
        causationId: sourceEventId,
      }),
    });
    expect(JSON.stringify(create.mock.calls)).not.toMatch(/\$argon|https?:\/\/|recipient/iu);
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      {
        action: 'identity.notification-delivery.replayed',
        targetType: 'identity.notification-delivery',
        targetId: deliveryId,
        afterMetadata: {
          deliveryType: NotificationDeliveryType.PASSWORD_RECOVERY,
          replayEventId: result.replayEventId,
        },
      },
      context(),
    );
  });

  it('uses the verification event only for a pending-verification user', async () => {
    const { service, create } = createSubject({
      delivery: {
        id: deliveryId,
        sourceEventId,
        userId,
        type: NotificationDeliveryType.EMAIL_VERIFICATION,
        status: NotificationDeliveryStatus.FAILED_TERMINAL,
        replayedAt: null,
        user: { status: AccountStatus.PENDING_VERIFICATION },
      },
    });

    await service.replay(deliveryId, context());

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
        eventVersion: EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
      }),
    });
  });

  it.each([
    [NotificationDeliveryStatus.QUEUED, null, AccountStatus.ACTIVE],
    [NotificationDeliveryStatus.ACCEPTED, null, AccountStatus.ACTIVE],
    [NotificationDeliveryStatus.FAILED_TERMINAL, new Date(), AccountStatus.ACTIVE],
    [NotificationDeliveryStatus.FAILED_TERMINAL, null, AccountStatus.SUSPENDED],
  ])(
    'rejects a delivery that is not currently eligible for replay',
    async (status, replayedAt, userStatus) => {
      const { service, updateMany, create, append } = createSubject({
        delivery: {
          id: deliveryId,
          sourceEventId,
          userId,
          type: NotificationDeliveryType.PASSWORD_RECOVERY,
          status,
          replayedAt,
          user: { status: userStatus },
        },
      });

      await expect(service.replay(deliveryId, context())).rejects.toEqual(
        new NotificationDeliveryReplayUnavailableError(),
      );
      expect(updateMany).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    },
  );

  it('rejects a concurrent claim loss without creating an event or audit evidence', async () => {
    const { service, create, append } = createSubject({ claimCount: 0 });

    await expect(service.replay(deliveryId, context())).rejects.toEqual(
      new NotificationDeliveryReplayUnavailableError(),
    );
    expect(create).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('rechecks current administrator authority inside the transaction', async () => {
    const { service, findUnique, updateMany } = createSubject({
      actor: {
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date(),
        userRoles: [{ role: RoleName.FULFILLER }],
      },
    });

    await expect(service.replay(deliveryId, context())).rejects.toEqual(new ForbiddenError());
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
