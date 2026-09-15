import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  IDENTITY_NOTIFICATION_QUEUE,
  SEND_EMAIL_VERIFICATION_JOB,
  SEND_PASSWORD_RECOVERY_JOB,
  SEND_ORDER_CONFIRMATION_JOB,
  type EmailVerificationJobData,
  type IdentityNotificationJobData,
  type PasswordRecoveryJobData,
  type OrderConfirmationJobData,
} from '@pulse-field/contracts';
import type { LocalProfile } from '@pulse-field/foundation';
import { Queue } from 'bullmq';
import { MESSAGING_PROFILE } from './messaging.constants';
import { queueConnectionFromUrl } from './queue-connection';

export interface OutboxPublisher {
  publishEmailVerification(data: EmailVerificationJobData): Promise<void>;
  publishPasswordRecovery(data: PasswordRecoveryJobData): Promise<void>;
  publishOrderConfirmation(data: OrderConfirmationJobData): Promise<void>;
}

@Injectable()
export class BullMqOutboxPublisher implements OutboxPublisher, OnModuleDestroy {
  private readonly queue: Queue<IdentityNotificationJobData> | undefined;

  constructor(@Inject(MESSAGING_PROFILE) profile: LocalProfile) {
    if (!profile.OUTBOX_RELAY_ENABLED) return;
    this.queue = new Queue<IdentityNotificationJobData>(IDENTITY_NOTIFICATION_QUEUE, {
      connection: queueConnectionFromUrl(profile.QUEUE_REDIS_URL),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
        removeOnFail: false,
      },
    });
  }

  async publishEmailVerification(data: EmailVerificationJobData): Promise<void> {
    if (!this.queue) throw new Error('Outbox relay is disabled.');
    await this.queue.add(SEND_EMAIL_VERIFICATION_JOB, data, { jobId: data.sourceEventId });
  }

  async publishPasswordRecovery(data: PasswordRecoveryJobData): Promise<void> {
    if (!this.queue) throw new Error('Outbox relay is disabled.');
    await this.queue.add(SEND_PASSWORD_RECOVERY_JOB, data, { jobId: data.sourceEventId });
  }

  async publishOrderConfirmation(data: OrderConfirmationJobData): Promise<void> {
    if (!this.queue) throw new Error('Outbox relay is disabled.');
    await this.queue.add(SEND_ORDER_CONFIRMATION_JOB, data, { jobId: data.sourceEventId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
