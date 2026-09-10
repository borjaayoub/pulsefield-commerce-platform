import {
  SEND_PASSWORD_RECOVERY_JOB,
  type NotificationProvider,
  type PasswordRecoveryDeliveryPayload,
  type PasswordRecoveryJobData,
} from '@pulse-field/contracts';
import { encryptQueueMessage } from '@pulse-field/foundation';
import { type Job, UnrecoverableError } from 'bullmq';
import { PasswordRecoveryProcessor } from './password-recovery.processor';
import { PASSWORD_RECOVERY_TEMPLATE } from './password-recovery.template';

describe('PasswordRecoveryProcessor', () => {
  const now = new Date('2026-09-02T19:00:00.000Z');
  const eventId = 'f62d69e7-0c86-4df8-b592-577815cb8461';
  const encryptionKey = Buffer.alloc(32, 4).toString('base64');
  const delivery: PasswordRecoveryDeliveryPayload = {
    version: 1,
    recipient: 'customer@example.test',
    passwordResetUrl: 'http://localhost:3000/reset-password?token=raw-password-reset-token',
    expiresAt: '2026-09-02T20:00:00.000Z',
  };

  function jobFor(payload = delivery): Job<PasswordRecoveryJobData> {
    return {
      id: eventId,
      name: SEND_PASSWORD_RECOVERY_JOB,
      data: {
        version: 1,
        sourceEventId: eventId,
        correlationId: 'request-12345678',
        userId: '6d6eb274-3885-474d-b3c3-09845a1d0f3f',
        encryptedDelivery: encryptQueueMessage(payload, encryptionKey),
      },
    } as Job<PasswordRecoveryJobData>;
  }

  function createSubject(previousEncryptionKey?: string) {
    const send = jest
      .fn()
      .mockResolvedValue({ providerMessageId: '<provider-id>', status: 'accepted' });
    return {
      processor: new PasswordRecoveryProcessor(
        encryptionKey,
        'http://localhost:3000',
        {
          send,
        } as NotificationProvider,
        previousEncryptionKey,
      ),
      send,
    };
  }

  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('decrypts, validates, and sends one typed recovery notification', async () => {
    const { processor, send } = createSubject();
    await processor.process(jobFor());
    expect(send).toHaveBeenCalledWith({
      recipient: delivery.recipient,
      template: PASSWORD_RECOVERY_TEMPLATE,
      locale: 'en',
      data: {
        passwordResetUrl: delivery.passwordResetUrl,
        expiresAt: delivery.expiresAt,
        sourceEventId: eventId,
      },
    });
  });

  it('accepts an authenticated job encrypted with the previous key during rotation', async () => {
    const previousKey = Buffer.alloc(32, 5).toString('base64');
    const { processor, send } = createSubject(previousKey);
    const job = jobFor();
    job.data.encryptedDelivery = encryptQueueMessage(delivery, previousKey);

    await processor.process(job);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects an external reset URL, expired credential, and tampered ciphertext', async () => {
    const { processor, send } = createSubject();
    await expect(
      processor.process(
        jobFor({
          ...delivery,
          passwordResetUrl: 'https://attacker.example/reset-password?token=x',
        }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processor.process(jobFor({ ...delivery, expiresAt: '2026-09-02T18:59:59.000Z' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    const tampered = jobFor();
    tampered.data.encryptedDelivery.ciphertext = `${tampered.data.encryptedDelivery.ciphertext.slice(0, -4)}AAAA`;
    await expect(processor.process(tampered)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves SMTP failures retryable', async () => {
    const { processor, send } = createSubject();
    send.mockRejectedValueOnce(new Error('SMTP unavailable'));
    await expect(processor.process(jobFor())).rejects.toThrow('SMTP unavailable');
  });
});
