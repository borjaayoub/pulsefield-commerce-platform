import {
  SEND_EMAIL_VERIFICATION_JOB,
  type EmailVerificationDeliveryPayload,
  type EmailVerificationJobData,
  type NotificationProvider,
} from '@pulse-field/contracts';
import { encryptQueueMessage } from '@pulse-field/foundation';
import { type Job, UnrecoverableError } from 'bullmq';
import { EmailVerificationProcessor } from './email-verification.processor';
import { EMAIL_VERIFICATION_TEMPLATE } from './verification-email.template';

describe('EmailVerificationProcessor', () => {
  const now = new Date('2026-09-01T20:00:00.000Z');
  const eventId = 'f62d69e7-0c86-4df8-b592-577815cb8461';
  const encryptionKey = Buffer.alloc(32, 4).toString('base64');
  const delivery: EmailVerificationDeliveryPayload = {
    version: 1,
    recipient: 'customer@example.test',
    verificationUrl: 'http://localhost:3000/verify-email?token=raw-verification-token',
    expiresAt: '2026-09-02T04:00:00.000Z',
  };

  function jobFor(payload = delivery): Job<EmailVerificationJobData> {
    return {
      id: eventId,
      name: SEND_EMAIL_VERIFICATION_JOB,
      data: {
        version: 1,
        sourceEventId: eventId,
        correlationId: 'request-12345678',
        userId: '6d6eb274-3885-474d-b3c3-09845a1d0f3f',
        encryptedDelivery: encryptQueueMessage(payload, encryptionKey),
      },
    } as Job<EmailVerificationJobData>;
  }

  function createSubject(previousEncryptionKey?: string) {
    const send = jest
      .fn()
      .mockResolvedValue({ providerMessageId: '<provider-id>', status: 'accepted' });
    const notifications = { send } as NotificationProvider;
    return {
      processor: new EmailVerificationProcessor(
        encryptionKey,
        'http://localhost:3000',
        notifications,
        previousEncryptionKey,
      ),
      send,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('decrypts, validates, and sends one typed verification notification', async () => {
    const { processor, send } = createSubject();

    await processor.process(jobFor());

    expect(send).toHaveBeenCalledWith({
      recipient: 'customer@example.test',
      template: EMAIL_VERIFICATION_TEMPLATE,
      locale: 'en',
      data: {
        verificationUrl: delivery.verificationUrl,
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

  it('rejects authenticated payloads that point outside the trusted web origin', async () => {
    const { processor, send } = createSubject();
    const job = jobFor({
      ...delivery,
      verificationUrl: 'https://attacker.example/verify-email?token=x',
    });

    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects expired verification credentials without SMTP work', async () => {
    const { processor, send } = createSubject();
    const job = jobFor({ ...delivery, expiresAt: '2026-09-01T19:59:59.000Z' });

    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });

  it('turns ciphertext authentication failures into terminal job errors', async () => {
    const { processor, send } = createSubject();
    const job = jobFor();
    job.data.encryptedDelivery.ciphertext = `${job.data.encryptedDelivery.ciphertext.slice(0, -4)}AAAA`;

    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves SMTP failures retryable', async () => {
    const { processor, send } = createSubject();
    send.mockRejectedValueOnce(new Error('SMTP unavailable'));

    await expect(processor.process(jobFor())).rejects.toThrow('SMTP unavailable');
  });

  it('treats malformed runtime job data as unrecoverable', async () => {
    const { processor, send } = createSubject();
    const malformed = jobFor();
    (malformed as unknown as { data: unknown }).data = null;

    await expect(processor.process(malformed)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });
});
