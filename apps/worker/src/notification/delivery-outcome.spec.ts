import { SEND_EMAIL_VERIFICATION_JOB, type EmailVerificationJobData } from '@pulse-field/contracts';
import type { Job } from 'bullmq';
import {
  buildAcceptedNotificationDeliveryOutcome,
  buildTerminalNotificationDeliveryOutcome,
  notificationDeliveryOutcomeJobId,
} from './delivery-outcome';

describe('notification delivery outcomes', () => {
  const sourceEventId = 'f62d69e7-0c86-4df8-b592-577815cb8461';

  it('uses only the source event and attempt count for accepted delivery evidence', () => {
    const job = {
      id: sourceEventId,
      name: SEND_EMAIL_VERIFICATION_JOB,
      attemptsMade: 1,
      data: { sourceEventId, encryptedDelivery: { ciphertext: 'not-copied' } },
    } as Job<EmailVerificationJobData>;

    expect(buildAcceptedNotificationDeliveryOutcome(job)).toEqual({
      version: 1,
      sourceEventId,
      status: 'accepted',
      workerAttemptCount: 1,
    });
  });

  it('converts terminal failure metadata to a fixed safe outcome', () => {
    expect(
      buildTerminalNotificationDeliveryOutcome({
        version: 1,
        sourceEventId,
        sourceJobId: sourceEventId,
        sourceJobName: SEND_EMAIL_VERIFICATION_JOB,
        failedAt: '2026-09-07T23:00:00.000Z',
        attemptsMade: 5,
        errorCode: 'NOTIFICATION_PROCESSING_FAILED',
      }),
    ).toEqual({
      version: 1,
      sourceEventId,
      status: 'failed-terminal',
      workerAttemptCount: 5,
      failureCode: 'NOTIFICATION_PROCESSING_FAILED',
    });
  });

  it('creates BullMQ-safe idempotency keys for accepted and terminal outcomes', () => {
    expect(
      notificationDeliveryOutcomeJobId({
        version: 1,
        sourceEventId,
        status: 'accepted',
        workerAttemptCount: 1,
      }),
    ).toBe(`${sourceEventId}-accepted`);
    expect(
      notificationDeliveryOutcomeJobId({
        version: 1,
        sourceEventId,
        status: 'failed-terminal',
        workerAttemptCount: 5,
        failureCode: 'NOTIFICATION_PROCESSING_FAILED',
      }),
    ).toBe(`${sourceEventId}-failed-terminal`);
  });
});
