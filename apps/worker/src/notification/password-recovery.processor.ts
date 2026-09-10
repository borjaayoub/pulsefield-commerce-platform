import {
  SEND_PASSWORD_RECOVERY_JOB,
  type NotificationProvider,
  type PasswordRecoveryDeliveryPayload,
  type PasswordRecoveryJobData,
} from '@pulse-field/contracts';
import { decryptQueueMessage } from '@pulse-field/foundation';
import { type Job, UnrecoverableError } from 'bullmq';
import { PASSWORD_RECOVERY_TEMPLATE } from './password-recovery.template';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJobData(value: unknown): PasswordRecoveryJobData {
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
  return value as unknown as PasswordRecoveryJobData;
}

function parseDeliveryPayload(value: unknown, webOrigin: string): PasswordRecoveryDeliveryPayload {
  if (!isRecord(value)) throw new UnrecoverableError('Notification payload is invalid.');
  const { version, recipient, passwordResetUrl, expiresAt } = value;
  if (
    version !== 1 ||
    typeof recipient !== 'string' ||
    recipient.length < 3 ||
    recipient.length > 255 ||
    !recipient.includes('@') ||
    typeof passwordResetUrl !== 'string' ||
    typeof expiresAt !== 'string'
  ) {
    throw new UnrecoverableError('Notification payload is invalid.');
  }

  let url: URL;
  try {
    url = new URL(passwordResetUrl);
  } catch {
    throw new UnrecoverableError('Notification payload is invalid.');
  }
  if (url.origin !== new URL(webOrigin).origin || url.pathname !== '/reset-password') {
    throw new UnrecoverableError('Notification password-reset URL is invalid.');
  }

  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new UnrecoverableError('Notification password-reset token has expired.');
  }

  return { version: 1, recipient, passwordResetUrl, expiresAt };
}

export class PasswordRecoveryProcessor {
  constructor(
    private readonly encryptionKey: string,
    private readonly webOrigin: string,
    private readonly notifications: NotificationProvider,
    private readonly previousEncryptionKey?: string,
  ) {}

  async process(job: Job<PasswordRecoveryJobData>): Promise<void> {
    const data = parseJobData(job.data);
    if (job.name !== SEND_PASSWORD_RECOVERY_JOB || !job.id || job.id !== data.sourceEventId) {
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
      template: PASSWORD_RECOVERY_TEMPLATE,
      locale: 'en',
      data: {
        passwordResetUrl: delivery.passwordResetUrl,
        expiresAt: delivery.expiresAt,
        sourceEventId: data.sourceEventId,
      },
    });
  }
}
