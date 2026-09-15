import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  PAYMENT_WEBHOOK_INBOX_QUEUE,
  PROCESS_PAYMENT_WEBHOOK_JOB,
  type PaymentWebhookInboxJobData,
} from '@pulse-field/contracts';
import type { LocalProfile } from '@pulse-field/foundation';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { queueWorkerConnectionFromUrl } from '../messaging/queue-connection';
import { PAYMENT_PROFILE } from './payment-webhook.constants';
import { PaymentWebhookProcessor } from './payment-webhook.processor';

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

export function parsePaymentWebhookJob(value: unknown): PaymentWebhookInboxJobData {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'inboxId,version' ||
    Reflect.get(value, 'version') !== 1 ||
    !isUuid(Reflect.get(value, 'inboxId'))
  ) {
    throw new UnrecoverableError('Payment webhook job is invalid.');
  }
  return { version: 1, inboxId: Reflect.get(value, 'inboxId') as string };
}

@Injectable()
export class PaymentWebhookConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentWebhookConsumer.name);
  private worker: Worker<PaymentWebhookInboxJobData> | undefined;

  constructor(
    private readonly processor: PaymentWebhookProcessor,
    @Inject(PAYMENT_PROFILE) private readonly profile: LocalProfile,
  ) {}

  onApplicationBootstrap(): void {
    if (this.profile.NODE_ENV === 'test') return;
    this.worker = new Worker<PaymentWebhookInboxJobData>(
      PAYMENT_WEBHOOK_INBOX_QUEUE,
      (job) => this.consume(job),
      { connection: queueWorkerConnectionFromUrl(this.profile.QUEUE_REDIS_URL) },
    );
    this.worker.on('error', () => this.logger.error('Payment webhook consumer failed.'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  async consume(job: Job<PaymentWebhookInboxJobData>): Promise<void> {
    if (job.name !== PROCESS_PAYMENT_WEBHOOK_JOB) {
      throw new UnrecoverableError('Payment webhook job is invalid.');
    }
    const data = parsePaymentWebhookJob(job.data);
    await this.processor.consume(data.inboxId);
  }
}
