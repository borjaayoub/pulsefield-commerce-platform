import { PrismaService } from '../database/prisma.service';
import { NotificationDeliveryStatus, NotificationDeliveryType } from '../generated/prisma/enums';
import { NotificationDeliveryService } from './notification-delivery.service';

describe('NotificationDeliveryService', () => {
  const sourceEventId = 'f62d69e7-0c86-4df8-b592-577815cb8461';

  function subject() {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { notificationDelivery: { upsert, updateMany } } as unknown as PrismaService;
    return { service: new NotificationDeliveryService(prisma), upsert, updateMany };
  }

  it('records only a safe queued delivery projection keyed by source event', async () => {
    const { service, upsert } = subject();
    await service.recordQueued({
      sourceEventId,
      userId: '6d6eb274-3885-474d-b3c3-09845a1d0f3f',
      type: NotificationDeliveryType.EMAIL_VERIFICATION,
      correlationId: 'correlation-123',
    });

    expect(upsert).toHaveBeenCalledWith({
      where: { sourceEventId },
      create: expect.not.objectContaining({ recipient: expect.anything() }),
      update: {},
    });
  });

  it('advances only a queued record to accepted', async () => {
    const { service, updateMany } = subject();
    await service.applyOutcome({
      version: 1,
      sourceEventId,
      status: 'accepted',
      workerAttemptCount: 1,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { sourceEventId, status: NotificationDeliveryStatus.QUEUED },
      data: expect.objectContaining({
        status: NotificationDeliveryStatus.ACCEPTED,
        workerAttemptCount: 1,
      }),
    });
  });

  it('stores only the fixed terminal failure code', async () => {
    const { service, updateMany } = subject();
    await service.applyOutcome({
      version: 1,
      sourceEventId,
      status: 'failed-terminal',
      workerAttemptCount: 5,
      failureCode: 'NOTIFICATION_PROCESSING_FAILED',
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: NotificationDeliveryStatus.FAILED_TERMINAL,
          failureCode: 'NOTIFICATION_PROCESSING_FAILED',
        }),
      }),
    );
  });
});
