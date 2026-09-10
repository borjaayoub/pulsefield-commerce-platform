import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { NotificationDeliveryStatus, NotificationDeliveryType } from '../generated/prisma/enums';
import { NotificationDeliveryService } from './notification-delivery.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('NotificationDeliveryService database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const service = new NotificationDeliveryService(prisma);
  const userId = randomUUID();
  const sourceEventId = randomUUID();

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        emailNormalized: `notification-ledger-${userId}@example.test`,
        passwordHash: 'integration-only-password-hash',
      },
    });
  });

  afterAll(async () => {
    await prisma.notificationDelivery.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('keeps one queued record and applies a terminal outcome exactly once', async () => {
    const queued = {
      sourceEventId,
      userId,
      type: NotificationDeliveryType.EMAIL_VERIFICATION,
      correlationId: `correlation-${sourceEventId}`,
    };
    await service.recordQueued(queued);
    await service.recordQueued(queued);

    await expect(prisma.notificationDelivery.count({ where: { sourceEventId } })).resolves.toBe(1);

    await service.applyOutcome({
      version: 1,
      sourceEventId,
      status: 'failed-terminal',
      workerAttemptCount: 5,
      failureCode: 'NOTIFICATION_PROCESSING_FAILED',
    });
    await service.applyOutcome({
      version: 1,
      sourceEventId,
      status: 'accepted',
      workerAttemptCount: 1,
    });

    await expect(
      prisma.notificationDelivery.findUniqueOrThrow({ where: { sourceEventId } }),
    ).resolves.toMatchObject({
      status: NotificationDeliveryStatus.FAILED_TERMINAL,
      failureCode: 'NOTIFICATION_PROCESSING_FAILED',
      workerAttemptCount: 5,
    });
  });
});
