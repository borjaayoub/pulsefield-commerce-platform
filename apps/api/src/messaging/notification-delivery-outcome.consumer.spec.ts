import { UnrecoverableError } from 'bullmq';
import { parseNotificationDeliveryOutcome } from './notification-delivery-outcome.consumer';

describe('NotificationDeliveryOutcomeConsumer', () => {
  const sourceEventId = 'f62d69e7-0c86-4df8-b592-577815cb8461';

  it('accepts only the safe, versioned worker outcome contract', () => {
    expect(
      parseNotificationDeliveryOutcome({
        version: 1,
        sourceEventId,
        status: 'failed-terminal',
        workerAttemptCount: 5,
        failureCode: 'NOTIFICATION_PROCESSING_FAILED',
      }),
    ).toMatchObject({ status: 'failed-terminal', sourceEventId });
  });

  it('rejects recipient or raw error-shaped outcomes', () => {
    expect(() =>
      parseNotificationDeliveryOutcome({
        version: 1,
        sourceEventId,
        status: 'accepted',
        workerAttemptCount: 1,
        recipient: 'customer@example.test',
      }),
    ).toThrow(UnrecoverableError);
  });
});
