import {
  IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE,
  IDENTITY_NOTIFICATION_QUEUE,
  NOTIFICATION_DELIVERY_OUTCOME_QUEUE,
} from '@pulse-field/contracts';
import { NotificationDeliveryStatus, OutboxMessageStatus } from '../generated/prisma/enums';
import { OUTBOX_CLAIM_LEASE_MS } from './messaging.constants';
import { collectMessagingDiagnostics } from './messaging-diagnostics';

describe('collectMessagingDiagnostics', () => {
  it('returns only fixed aggregate state and uses the relay lease window for stale claims', async () => {
    const groupOutbox = jest.fn().mockResolvedValue([
      { status: OutboxMessageStatus.PENDING, _count: { _all: 3 } },
      { status: OutboxMessageStatus.DEAD_LETTER, _count: { _all: 2 } },
    ]);
    const countStale = jest.fn().mockResolvedValue(1);
    const groupDeliveries = jest.fn().mockResolvedValue([
      { status: NotificationDeliveryStatus.QUEUED, _count: { _all: 4 } },
      { status: NotificationDeliveryStatus.FAILED_TERMINAL, _count: { _all: 1 } },
    ]);
    const identityCounts = jest.fn().mockResolvedValue({ waiting: 2, active: 1, failed: 4 });
    const outcomeCounts = jest.fn().mockResolvedValue({ delayed: 3 });
    const deadLetterCounts = jest.fn().mockResolvedValue({ waiting: 5 });
    const now = new Date('2026-09-08T10:00:00.000Z');

    const result = await collectMessagingDiagnostics(
      {
        outboxMessage: { groupBy: groupOutbox, count: countStale },
        notificationDelivery: { groupBy: groupDeliveries },
      },
      {
        identityNotifications: { getJobCounts: identityCounts },
        deliveryOutcomes: { getJobCounts: outcomeCounts },
        notificationDeadLetter: { getJobCounts: deadLetterCounts },
      },
      now,
    );

    expect(countStale).toHaveBeenCalledWith({
      where: {
        status: OutboxMessageStatus.PENDING,
        claimedAt: { lte: new Date(now.getTime() - OUTBOX_CLAIM_LEASE_MS) },
      },
    });
    expect(result).toEqual({
      outbox: { pending: 3, staleClaims: 1, deadLettered: 2 },
      notificationDeliveries: { queued: 4, accepted: 0, failedTerminal: 1 },
      queues: {
        [IDENTITY_NOTIFICATION_QUEUE]: { waiting: 2, active: 1, delayed: 0, failed: 4 },
        [NOTIFICATION_DELIVERY_OUTCOME_QUEUE]: { waiting: 0, active: 0, delayed: 3, failed: 0 },
        [IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE]: { waiting: 5, active: 0, delayed: 0, failed: 0 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/email|recipient|token|password|redis:|postgres/iu);
  });
});
