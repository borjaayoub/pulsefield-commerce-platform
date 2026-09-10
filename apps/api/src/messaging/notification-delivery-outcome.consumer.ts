import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  NOTIFICATION_DELIVERY_OUTCOME_JOB,
  NOTIFICATION_DELIVERY_OUTCOME_QUEUE,
  type NotificationDeliveryOutcomeJobData,
} from '@pulse-field/contracts';
import type { LocalProfile } from '@pulse-field/foundation';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { MESSAGING_PROFILE } from './messaging.constants';
import { NotificationDeliveryService } from './notification-delivery.service';
import { queueWorkerConnectionFromUrl } from './queue-connection';

function isSafeUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

export function parseNotificationDeliveryOutcome(
  value: unknown,
): NotificationDeliveryOutcomeJobData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnrecoverableError('Notification delivery outcome is invalid.');
  }
  const sourceEventId = Reflect.get(value, 'sourceEventId');
  const status = Reflect.get(value, 'status');
  const version = Reflect.get(value, 'version');
  const workerAttemptCount = Reflect.get(value, 'workerAttemptCount');
  const keys = Object.keys(value).sort();
  if (
    version !== 1 ||
    !isSafeUuid(sourceEventId) ||
    !Number.isSafeInteger(workerAttemptCount) ||
    workerAttemptCount < 1 ||
    workerAttemptCount > 5
  ) {
    throw new UnrecoverableError('Notification delivery outcome is invalid.');
  }
  if (status === 'accepted') {
    if (keys.join(',') !== 'sourceEventId,status,version,workerAttemptCount') {
      throw new UnrecoverableError('Notification delivery outcome is invalid.');
    }
    return { version, sourceEventId, status, workerAttemptCount };
  }
  if (
    status === 'failed-terminal' &&
    Reflect.get(value, 'failureCode') === 'NOTIFICATION_PROCESSING_FAILED' &&
    keys.join(',') === 'failureCode,sourceEventId,status,version,workerAttemptCount'
  ) {
    return {
      version,
      sourceEventId,
      status,
      workerAttemptCount,
      failureCode: 'NOTIFICATION_PROCESSING_FAILED',
    };
  }
  throw new UnrecoverableError('Notification delivery outcome is invalid.');
}

@Injectable()
export class NotificationDeliveryOutcomeConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationDeliveryOutcomeConsumer.name);
  private worker: Worker<NotificationDeliveryOutcomeJobData> | undefined;

  constructor(
    private readonly deliveries: NotificationDeliveryService,
    @Inject(MESSAGING_PROFILE) private readonly profile: LocalProfile,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.profile.OUTBOX_RELAY_ENABLED) return;
    this.worker = new Worker<NotificationDeliveryOutcomeJobData>(
      NOTIFICATION_DELIVERY_OUTCOME_QUEUE,
      async (job) => this.consume(job),
      {
        connection: queueWorkerConnectionFromUrl(this.profile.QUEUE_REDIS_URL),
      },
    );
    this.worker.on('error', () => {
      this.logger.error('Notification delivery outcome consumer failed.');
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  async consume(job: Job<NotificationDeliveryOutcomeJobData>): Promise<void> {
    if (job.name !== NOTIFICATION_DELIVERY_OUTCOME_JOB) {
      throw new UnrecoverableError('Notification delivery outcome is invalid.');
    }
    await this.deliveries.applyOutcome(parseNotificationDeliveryOutcome(job.data));
  }
}
