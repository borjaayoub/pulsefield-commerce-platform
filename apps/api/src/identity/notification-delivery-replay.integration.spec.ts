import { randomUUID } from 'node:crypto';
import type { AuditedCommandContext } from '../audit/command-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  AccountStatus,
  NotificationDeliveryStatus,
  NotificationDeliveryType,
  RoleName,
} from '../generated/prisma/enums';
import { NotificationDeliveryReplayService } from './notification-delivery-replay.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('notification-delivery replay integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const service = new NotificationDeliveryReplayService(prisma, new AuditService());
  const administratorId = randomUUID();
  const userId = randomUUID();
  const deliveryId = randomUUID();
  const sourceEventId = randomUUID();

  function context(): AuditedCommandContext {
    const id = randomUUID();
    return {
      requestId: `request-${id}`,
      correlationId: `correlation-${id}`,
      idempotencyKey: `idempotency-${id}`,
      actor: { type: 'staff', id: administratorId, roles: [RoleName.ADMINISTRATOR] },
      reason: 'Retry an identity notification after a terminal delivery failure',
    };
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: administratorId,
        emailNormalized: `replay-admin-${administratorId}@example.test`,
        passwordHash: 'integration-only-password-hash',
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date(),
        userRoles: { create: { role: RoleName.ADMINISTRATOR } },
      },
    });
    await prisma.user.create({
      data: {
        id: userId,
        emailNormalized: `replay-user-${userId}@example.test`,
        passwordHash: 'integration-only-password-hash',
        status: AccountStatus.PENDING_VERIFICATION,
      },
    });
    await prisma.notificationDelivery.create({
      data: {
        id: deliveryId,
        sourceEventId,
        userId,
        type: NotificationDeliveryType.EMAIL_VERIFICATION,
        status: NotificationDeliveryStatus.FAILED_TERMINAL,
        correlationId: `delivery-${sourceEventId}`,
        failedAt: new Date(),
        failureCode: 'NOTIFICATION_PROCESSING_FAILED',
        workerAttemptCount: 5,
      },
    });
  });

  afterAll(async () => {
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: userId } });
    await prisma.notificationDelivery.deleteMany({ where: { id: deliveryId } });
    await prisma.userRole.deleteMany({ where: { userId: administratorId } });
    await prisma.user.deleteMany({ where: { id: { in: [administratorId, userId] } } });
    await prisma.$disconnect();
  });

  it('creates exactly one fresh event while preserving the terminal ledger evidence', async () => {
    const first = service.replay(deliveryId, context());
    const second = service.replay(deliveryId, context());
    const results = await Promise.allSettled([first, second]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const stored = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(stored).toMatchObject({
      status: NotificationDeliveryStatus.FAILED_TERMINAL,
      replayedBy: administratorId,
    });
    expect(stored.replayedAt).toBeInstanceOf(Date);
    await expect(
      prisma.outboxMessage.count({
        where: {
          aggregateId: userId,
          eventType: 'identity.email-verification.requested',
          payload: { equals: { userId } },
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.auditRecord.count({
        where: {
          action: 'identity.notification-delivery.replayed',
          targetId: deliveryId,
        },
      }),
    ).resolves.toBe(1);
  });
});
