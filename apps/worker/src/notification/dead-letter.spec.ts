import { SEND_EMAIL_VERIFICATION_JOB, type EmailVerificationJobData } from '@pulse-field/contracts';
import { type Job, UnrecoverableError } from 'bullmq';
import { buildNotificationDeadLetter } from './dead-letter';

describe('notification dead-letter metadata', () => {
  const failedAt = new Date('2026-09-01T20:00:00.000Z');
  const sourceEventId = 'f62d69e7-0c86-4df8-b592-577815cb8461';

  function job(attemptsMade: number): Job<EmailVerificationJobData> {
    return {
      id: sourceEventId,
      name: SEND_EMAIL_VERIFICATION_JOB,
      attemptsMade,
      opts: { attempts: 5 },
      data: {
        version: 1,
        sourceEventId,
        correlationId: 'request-12345678',
        userId: '6d6eb274-3885-474d-b3c3-09845a1d0f3f',
        encryptedDelivery: {
          version: 1,
          algorithm: 'aes-256-gcm',
          initializationVector: 'not-copied',
          authenticationTag: 'not-copied',
          ciphertext: 'not-copied',
        },
      },
    } as Job<EmailVerificationJobData>;
  }

  it('waits until retryable attempts are exhausted', () => {
    expect(buildNotificationDeadLetter(job(1), new Error('temporary'), failedAt)).toBeNull();
  });

  it('creates only redacted metadata after the final attempt', () => {
    const deadLetter = buildNotificationDeadLetter(job(5), new Error('smtp secret'), failedAt);

    expect(deadLetter).toEqual({
      version: 1,
      sourceEventId,
      sourceJobId: sourceEventId,
      sourceJobName: SEND_EMAIL_VERIFICATION_JOB,
      failedAt: failedAt.toISOString(),
      attemptsMade: 5,
      errorCode: 'NOTIFICATION_PROCESSING_FAILED',
    });
    expect(JSON.stringify(deadLetter)).not.toContain('smtp secret');
    expect(JSON.stringify(deadLetter)).not.toContain('not-copied');
  });

  it('dead-letters unrecoverable contract errors immediately', () => {
    expect(
      buildNotificationDeadLetter(
        job(1),
        new UnrecoverableError('invalid secret payload'),
        failedAt,
      ),
    ).not.toBeNull();
  });

  it('uses the broker job ID when malformed data has no source event ID', () => {
    const malformed = job(1);
    (malformed as unknown as { data: unknown }).data = null;

    expect(
      buildNotificationDeadLetter(malformed, new UnrecoverableError('invalid payload'), failedAt),
    ).toMatchObject({ sourceEventId, sourceJobId: sourceEventId });
  });
});
