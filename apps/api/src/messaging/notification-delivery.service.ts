import { Injectable } from '@nestjs/common';
import type { NotificationDeliveryOutcomeJobData } from '@pulse-field/contracts';
import { PrismaService } from '../database/prisma.service';
import { NotificationDeliveryStatus, NotificationDeliveryType } from '../generated/prisma/enums';

export interface QueueNotificationDeliveryInput {
  sourceEventId: string;
  userId: string;
  type: NotificationDeliveryType;
  correlationId: string;
}

@Injectable()
export class NotificationDeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  async recordQueued(input: QueueNotificationDeliveryInput): Promise<void> {
    await this.prisma.notificationDelivery.upsert({
      where: { sourceEventId: input.sourceEventId },
      create: input,
      update: {},
    });
  }

  async applyOutcome(outcome: NotificationDeliveryOutcomeJobData): Promise<void> {
    const data =
      outcome.status === 'accepted'
        ? {
            status: NotificationDeliveryStatus.ACCEPTED,
            acceptedAt: new Date(),
            workerAttemptCount: outcome.workerAttemptCount,
          }
        : {
            status: NotificationDeliveryStatus.FAILED_TERMINAL,
            failedAt: new Date(),
            failureCode: outcome.failureCode,
            workerAttemptCount: outcome.workerAttemptCount,
          };

    await this.prisma.notificationDelivery.updateMany({
      where: {
        sourceEventId: outcome.sourceEventId,
        status: NotificationDeliveryStatus.QUEUED,
      },
      data,
    });
  }
}
