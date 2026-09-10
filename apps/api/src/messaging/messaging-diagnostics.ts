import {
  IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE,
  IDENTITY_NOTIFICATION_QUEUE,
  NOTIFICATION_DELIVERY_OUTCOME_QUEUE,
} from '@pulse-field/contracts';
import { NotificationDeliveryStatus, OutboxMessageStatus } from '../generated/prisma/enums';
import { OUTBOX_CLAIM_LEASE_MS } from './messaging.constants';

export interface MessagingDiagnosticsDatabase {
  outboxMessage: {
    groupBy(args: {
      by: ['status'];
      _count: { _all: true };
    }): Promise<Array<{ status: OutboxMessageStatus; _count: { _all: number } }>>;
    count(args: {
      where: { status: OutboxMessageStatus; claimedAt: { lte: Date } };
    }): Promise<number>;
  };
  notificationDelivery: {
    groupBy(args: {
      by: ['status'];
      _count: { _all: true };
    }): Promise<Array<{ status: NotificationDeliveryStatus; _count: { _all: number } }>>;
  };
}

export interface MessagingQueueDiagnosticsReader {
  getJobCounts(
    ...types: Array<'waiting' | 'active' | 'delayed' | 'failed'>
  ): Promise<Partial<Record<'waiting' | 'active' | 'delayed' | 'failed', number>>>;
}

export interface MessagingDiagnosticsQueues {
  identityNotifications: MessagingQueueDiagnosticsReader;
  deliveryOutcomes: MessagingQueueDiagnosticsReader;
  notificationDeadLetter: MessagingQueueDiagnosticsReader;
}

export interface QueueDiagnosticsSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface MessagingDiagnosticsSnapshot {
  outbox: {
    pending: number;
    staleClaims: number;
    deadLettered: number;
  };
  notificationDeliveries: {
    queued: number;
    accepted: number;
    failedTerminal: number;
  };
  queues: {
    [IDENTITY_NOTIFICATION_QUEUE]: QueueDiagnosticsSnapshot;
    [NOTIFICATION_DELIVERY_OUTCOME_QUEUE]: QueueDiagnosticsSnapshot;
    [IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE]: QueueDiagnosticsSnapshot;
  };
}

function countFor<T extends string>(
  rows: Array<{ status: T; _count: { _all: number } }>,
  status: T,
): number {
  return rows.find((row) => row.status === status)?._count._all ?? 0;
}

function compactQueueCounts(
  counts: Partial<Record<'waiting' | 'active' | 'delayed' | 'failed', number>>,
): QueueDiagnosticsSnapshot {
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
  };
}

export async function collectMessagingDiagnostics(
  database: MessagingDiagnosticsDatabase,
  queues: MessagingDiagnosticsQueues,
  now = new Date(),
): Promise<MessagingDiagnosticsSnapshot> {
  const staleBefore = new Date(now.getTime() - OUTBOX_CLAIM_LEASE_MS);
  const [outbox, staleClaims, deliveries, identityNotifications, deliveryOutcomes, deadLetter] =
    await Promise.all([
      database.outboxMessage.groupBy({ by: ['status'], _count: { _all: true } }),
      database.outboxMessage.count({
        where: {
          status: OutboxMessageStatus.PENDING,
          claimedAt: { lte: staleBefore },
        },
      }),
      database.notificationDelivery.groupBy({ by: ['status'], _count: { _all: true } }),
      queues.identityNotifications.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      queues.deliveryOutcomes.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      queues.notificationDeadLetter.getJobCounts('waiting', 'active', 'delayed', 'failed'),
    ]);

  return {
    outbox: {
      pending: countFor(outbox, OutboxMessageStatus.PENDING),
      staleClaims,
      deadLettered: countFor(outbox, OutboxMessageStatus.DEAD_LETTER),
    },
    notificationDeliveries: {
      queued: countFor(deliveries, NotificationDeliveryStatus.QUEUED),
      accepted: countFor(deliveries, NotificationDeliveryStatus.ACCEPTED),
      failedTerminal: countFor(deliveries, NotificationDeliveryStatus.FAILED_TERMINAL),
    },
    queues: {
      [IDENTITY_NOTIFICATION_QUEUE]: compactQueueCounts(identityNotifications),
      [NOTIFICATION_DELIVERY_OUTCOME_QUEUE]: compactQueueCounts(deliveryOutcomes),
      [IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE]: compactQueueCounts(deadLetter),
    },
  };
}
