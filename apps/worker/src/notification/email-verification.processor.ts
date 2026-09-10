import {
  SEND_EMAIL_VERIFICATION_JOB,
  type EmailVerificationDeliveryPayload,
  type EmailVerificationJobData,
  type NotificationProvider,
} from '@pulse-field/contracts';
import { decryptQueueMessage } from '@pulse-field/foundation';
import { type Job, UnrecoverableError } from 'bullmq';
import { EMAIL_VERIFICATION_TEMPLATE } from './verification-email.template';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJobData(value: unknown): EmailVerificationJobData {
  if (!isRecord(value)) throw new UnrecoverableError('Notification job contract is invalid.');
  const { version, sourceEventId, correlationId, userId, encryptedDelivery } = value;
  if (
    version !== 1 ||
    typeof sourceEventId !== 'string' ||
    sourceEventId.length === 0 ||
    typeof correlationId !== 'string' ||
    correlationId.length === 0 ||
    typeof userId !== 'string' ||
    userId.length === 0 ||
    !isRecord(encryptedDelivery) ||
    encryptedDelivery.version !== 1 ||
    encryptedDelivery.algorithm !== 'aes-256-gcm' ||
    typeof encryptedDelivery.initializationVector !== 'string' ||
    typeof encryptedDelivery.authenticationTag !== 'string' ||
    typeof encryptedDelivery.ciphertext !== 'string'
  ) {
    throw new UnrecoverableError('Notification job contract is invalid.');
  }

  return value as unknown as EmailVerificationJobData;
}

function parseDeliveryPayload(value: unknown, webOrigin: string): EmailVerificationDeliveryPayload {
  if (!isRecord(value)) throw new UnrecoverableError('Notification payload is invalid.');
  const { version, recipient, verificationUrl, expiresAt } = value;
  if (
    version !== 1 ||
    typeof recipient !== 'string' ||
    recipient.length < 3 ||
    recipient.length > 255 ||
    !recipient.includes('@') ||
    typeof verificationUrl !== 'string' ||
    typeof expiresAt !== 'string'
  ) {
    throw new UnrecoverableError('Notification payload is invalid.');
  }

  let url: URL;
  try {
    url = new URL(verificationUrl);
  } catch {
    throw new UnrecoverableError('Notification payload is invalid.');
  }
  if (url.origin !== new URL(webOrigin).origin || url.pathname !== '/verify-email') {
    throw new UnrecoverableError('Notification verification URL is invalid.');
  }

  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new UnrecoverableError('Notification verification token has expired.');
  }

  return { version: 1, recipient, verificationUrl, expiresAt };
}

export class EmailVerificationProcessor {
  constructor(
    private readonly encryptionKey: string,
    private readonly webOrigin: string,
    private readonly notifications: NotificationProvider,
    private readonly previousEncryptionKey?: string,
  ) {}

  async process(job: Job<EmailVerificationJobData>): Promise<void> {
    const data = parseJobData(job.data);
    if (job.name !== SEND_EMAIL_VERIFICATION_JOB || !job.id || job.id !== data.sourceEventId) {
      throw new UnrecoverableError('Notification job contract is invalid.');
    }

    let decrypted: unknown;
    try {
      decrypted = decryptQueueMessage(
        data.encryptedDelivery,
        this.encryptionKey,
        this.previousEncryptionKey,
      );
    } catch {
      throw new UnrecoverableError('Notification payload authentication failed.');
    }
    const delivery = parseDeliveryPayload(decrypted, this.webOrigin);

    await this.notifications.send({
      recipient: delivery.recipient,
      template: EMAIL_VERIFICATION_TEMPLATE,
      locale: 'en',
      data: {
        verificationUrl: delivery.verificationUrl,
        expiresAt: delivery.expiresAt,
        sourceEventId: data.sourceEventId,
      },
    });
  }
}
