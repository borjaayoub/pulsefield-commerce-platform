import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  PAYMENT_WEBHOOK_INBOX_QUEUE,
  PROCESS_PAYMENT_WEBHOOK_JOB,
  type PaymentWebhookInboxJobData,
} from '@pulse-field/contracts';
import type { LocalProfile } from '@pulse-field/foundation';
import { Queue } from 'bullmq';
import { queueConnectionFromUrl } from '../messaging/queue-connection';
import { PAYMENT_PROFILE, PAYMENT_PROVIDER_RETRY_ATTEMPTS } from './payment-webhook.constants';

export const PAYMENT_WEBHOOK_JOB_OPTIONS = {
  attempts: PAYMENT_PROVIDER_RETRY_ATTEMPTS,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
  removeOnFail: true,
} as const;

export interface PaymentWebhookPublisher {
  publish(data: PaymentWebhookInboxJobData, processingAttempt: number): Promise<void>;
}

export function paymentWebhookJobId(inboxId: string, processingAttempt: number): string {
  return `payment-webhook-${inboxId}-${processingAttempt}`;
}

@Injectable()
export class BullMqPaymentWebhookPublisher implements PaymentWebhookPublisher, OnModuleDestroy {
  private readonly queue: Queue<PaymentWebhookInboxJobData>;

  constructor(@Inject(PAYMENT_PROFILE) profile: LocalProfile) {
    this.queue = new Queue<PaymentWebhookInboxJobData>(PAYMENT_WEBHOOK_INBOX_QUEUE, {
      connection: queueConnectionFromUrl(profile.QUEUE_REDIS_URL),
      defaultJobOptions: PAYMENT_WEBHOOK_JOB_OPTIONS,
    });
  }

  async publish(data: PaymentWebhookInboxJobData, processingAttempt: number): Promise<void> {
    await this.queue.add(PROCESS_PAYMENT_WEBHOOK_JOB, data, {
      jobId: paymentWebhookJobId(data.inboxId, processingAttempt),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
