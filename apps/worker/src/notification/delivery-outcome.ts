import type {
  IdentityNotificationJobData,
  NotificationDeadLetterJobData,
  NotificationDeliveryOutcomeJobData,
} from '@pulse-field/contracts';
import type { Job } from 'bullmq';

function sourceEventId(job: Job<IdentityNotificationJobData>): string | null {
  const id = job.data?.sourceEventId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function buildAcceptedNotificationDeliveryOutcome(
  job: Job<IdentityNotificationJobData>,
): NotificationDeliveryOutcomeJobData | null {
  const id = sourceEventId(job);
  if (!id) return null;
  return {
    version: 1,
    sourceEventId: id,
    status: 'accepted',
    workerAttemptCount: Math.max(1, job.attemptsMade),
  };
}

export function buildTerminalNotificationDeliveryOutcome(
  deadLetter: NotificationDeadLetterJobData,
): NotificationDeliveryOutcomeJobData {
  return {
    version: 1,
    sourceEventId: deadLetter.sourceEventId,
    status: 'failed-terminal',
    workerAttemptCount: deadLetter.attemptsMade,
    failureCode: deadLetter.errorCode,
  };
}

export function notificationDeliveryOutcomeJobId(
  outcome: NotificationDeliveryOutcomeJobData,
): string {
  return `${outcome.sourceEventId}-${outcome.status}`;
}
