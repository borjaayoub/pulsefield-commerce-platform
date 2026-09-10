import type {
  IdentityNotificationJobData,
  NotificationDeadLetterJobData,
} from '@pulse-field/contracts';
import { type Job, UnrecoverableError } from 'bullmq';

export function buildNotificationDeadLetter(
  job: Job<IdentityNotificationJobData>,
  error: Error,
  failedAt = new Date(),
): NotificationDeadLetterJobData | null {
  const allowedAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
  if (!(error instanceof UnrecoverableError) && job.attemptsMade < allowedAttempts) return null;
  const sourceEventId =
    job.data && typeof job.data.sourceEventId === 'string' && job.data.sourceEventId.length > 0
      ? job.data.sourceEventId
      : job.id;
  if (!sourceEventId) return null;

  return {
    version: 1,
    sourceEventId,
    sourceJobId: job.id ?? sourceEventId,
    sourceJobName: job.name,
    failedAt: failedAt.toISOString(),
    attemptsMade: job.attemptsMade,
    errorCode: 'NOTIFICATION_PROCESSING_FAILED',
  };
}
