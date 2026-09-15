import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuditedCommandContext } from '../audit/command-context';
import { normalizeAuditedCommandContext } from '../audit/command-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  AccountStatus,
  NotificationDeliveryStatus,
  NotificationDeliveryType,
  RoleName,
} from '../generated/prisma/enums';
import {
  EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
  EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
} from './email-verification-request.service';
import {
  ForbiddenError,
  NotificationDeliveryReplayUnavailableError,
} from './authentication.errors';
import {
  PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
  PASSWORD_RECOVERY_REQUEST_EVENT_VERSION,
} from './password-recovery-request.service';

export interface NotificationDeliveryReplayView {
  deliveryId: string;
  replayEventId: string;
}

function eventFor(type: NotificationDeliveryType) {
  return type === NotificationDeliveryType.EMAIL_VERIFICATION
    ? {
        eventType: EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
        eventVersion: EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
        requiredAccountStatus: AccountStatus.PENDING_VERIFICATION,
      }
    : {
        eventType: PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
        eventVersion: PASSWORD_RECOVERY_REQUEST_EVENT_VERSION,
        requiredAccountStatus: AccountStatus.ACTIVE,
      };
}

@Injectable()
export class NotificationDeliveryReplayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async replay(
    deliveryId: string,
    context: AuditedCommandContext,
  ): Promise<NotificationDeliveryReplayView> {
    const command = normalizeAuditedCommandContext(context);
    if (!command.actor.roles.includes(RoleName.ADMINISTRATOR)) throw new ForbiddenError();
    const replayedAt = new Date();
    const replayEventId = randomUUID();

    return this.prisma.$transaction(async (transaction) => {
      const actor = await transaction.user.findUnique({
        where: { id: command.actor.id },
        select: {
          status: true,
          verifiedAt: true,
          userRoles: { select: { role: true } },
        },
      });
      if (
        !actor ||
        actor.status !== AccountStatus.ACTIVE ||
        !actor.verifiedAt ||
        !actor.userRoles.some(({ role }) => role === RoleName.ADMINISTRATOR)
      ) {
        throw new ForbiddenError();
      }

      const delivery = await transaction.notificationDelivery.findUnique({
        where: { id: deliveryId },
        select: {
          id: true,
          sourceEventId: true,
          userId: true,
          type: true,
          status: true,
          replayedAt: true,
          user: { select: { status: true } },
        },
      });
      if (
        !delivery ||
        !delivery.userId ||
        !delivery.user ||
        delivery.status !== NotificationDeliveryStatus.FAILED_TERMINAL ||
        delivery.replayedAt !== null
      ) {
        throw new NotificationDeliveryReplayUnavailableError();
      }

      const event = eventFor(delivery.type);
      if (delivery.user.status !== event.requiredAccountStatus) {
        throw new NotificationDeliveryReplayUnavailableError();
      }

      const claimed = await transaction.notificationDelivery.updateMany({
        where: {
          id: delivery.id,
          status: NotificationDeliveryStatus.FAILED_TERMINAL,
          replayedAt: null,
        },
        data: { replayedAt, replayedBy: command.actor.id },
      });
      if (claimed.count !== 1) throw new NotificationDeliveryReplayUnavailableError();

      await transaction.outboxMessage.create({
        data: {
          id: replayEventId,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          aggregateType: 'User',
          aggregateId: delivery.userId,
          payload: { userId: delivery.userId },
          correlationId: command.correlationId,
          causationId: delivery.sourceEventId,
        },
      });
      await this.audit.append(
        transaction,
        {
          action: 'identity.notification-delivery.replayed',
          targetType: 'identity.notification-delivery',
          targetId: delivery.id,
          afterMetadata: { deliveryType: delivery.type, replayEventId },
        },
        context,
      );

      return { deliveryId: delivery.id, replayEventId };
    });
  }
}
