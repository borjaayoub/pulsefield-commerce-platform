import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type {
  EmailVerificationDeliveryPayload,
  EmailVerificationJobData,
  PasswordRecoveryDeliveryPayload,
  PasswordRecoveryJobData,
} from '@pulse-field/contracts';
import { encryptQueueMessage, type LocalProfile } from '@pulse-field/foundation';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import {
  AccountStatus,
  NotificationDeliveryType,
  OutboxMessageStatus,
} from '../generated/prisma/enums';
import {
  CUSTOMER_REGISTERED_EVENT_TYPE,
  CUSTOMER_REGISTERED_EVENT_VERSION,
} from '../identity/customer-registration.service';
import { EmailVerificationTokenService } from '../identity/email-verification-token.service';
import {
  EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
  EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
} from '../identity/email-verification-request.service';
import {
  PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
  PASSWORD_RECOVERY_REQUEST_EVENT_VERSION,
} from '../identity/password-recovery-request.service';
import { PasswordResetTokenService } from '../identity/password-reset-token.service';
import { MESSAGING_PROFILE, OUTBOX_CLAIM_LEASE_MS, OUTBOX_PUBLISHER } from './messaging.constants';
import type { OutboxPublisher } from './bullmq-outbox.publisher';
import { NotificationDeliveryService } from './notification-delivery.service';

const POLL_INTERVAL_MS = 1_000;
const MAX_PUBLICATION_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const SUPPORTED_NOTIFICATION_EVENT_TYPES = [
  CUSTOMER_REGISTERED_EVENT_TYPE,
  EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
  PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
];

type ClaimedOutboxMessage = {
  id: string;
  eventType: string;
  eventVersion: number;
  aggregateId: string;
  payload: unknown;
  correlationId: string;
  attemptCount: number;
};

export function calculateOutboxRetryDelayMs(attempt: number, randomValue = Math.random()): number {
  const exponentialDelay = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
  const jitterMultiplier = 0.5 + Math.min(1, Math.max(0, randomValue));
  return Math.min(Math.round(exponentialDelay * jitterMultiplier), MAX_RETRY_DELAY_MS);
}

function registeredUserId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const userId = Reflect.get(payload, 'userId');
  return typeof userId === 'string' && userId.length > 0 ? userId : null;
}

@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly relayId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly verificationTokens: EmailVerificationTokenService,
    private readonly passwordResetTokens: PasswordResetTokenService,
    private readonly deliveries: NotificationDeliveryService,
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisher,
    @Inject(MESSAGING_PROFILE) private readonly profile: LocalProfile,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.profile.OUTBOX_RELAY_ENABLED) return;
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async drainOnce(): Promise<boolean> {
    const message = await this.claimNext();
    if (!message) return false;
    await this.dispatch(message);
    return true;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.drainOnce();
    } catch {
      this.logger.error('Outbox relay poll failed.');
    } finally {
      this.polling = false;
    }
  }

  private async claimNext(): Promise<ClaimedOutboxMessage | null> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - OUTBOX_CLAIM_LEASE_MS);
    const claimable: Prisma.OutboxMessageWhereInput = {
      status: OutboxMessageStatus.PENDING,
      eventType: { in: SUPPORTED_NOTIFICATION_EVENT_TYPES },
      availableAt: { lte: now },
      OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }],
    };
    const candidate = await this.prisma.outboxMessage.findFirst({
      where: claimable,
      orderBy: [{ availableAt: 'asc' }, { occurredAt: 'asc' }],
      select: {
        id: true,
        eventType: true,
        eventVersion: true,
        aggregateId: true,
        payload: true,
        correlationId: true,
        attemptCount: true,
      },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.outboxMessage.updateMany({
      where: { id: candidate.id, ...claimable },
      data: { claimedAt: now, claimedBy: this.relayId },
    });

    return claimed.count === 1 ? candidate : null;
  }

  private async dispatch(message: ClaimedOutboxMessage): Promise<void> {
    const supportedVerificationEvent =
      (message.eventType === CUSTOMER_REGISTERED_EVENT_TYPE &&
        message.eventVersion === CUSTOMER_REGISTERED_EVENT_VERSION) ||
      (message.eventType === EMAIL_VERIFICATION_REQUEST_EVENT_TYPE &&
        message.eventVersion === EMAIL_VERIFICATION_REQUEST_EVENT_VERSION);
    const supportedRecoveryEvent =
      message.eventType === PASSWORD_RECOVERY_REQUEST_EVENT_TYPE &&
      message.eventVersion === PASSWORD_RECOVERY_REQUEST_EVENT_VERSION;

    if (!supportedVerificationEvent && !supportedRecoveryEvent) {
      await this.deadLetter(message.id, 'UNSUPPORTED_OUTBOX_EVENT');
      return;
    }

    const userId = registeredUserId(message.payload);
    if (!userId || userId !== message.aggregateId) {
      await this.deadLetter(message.id, 'INVALID_OUTBOX_PAYLOAD');
      return;
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { emailNormalized: true, status: true },
      });

      if (!user) {
        await this.deadLetter(message.id, 'REGISTRATION_USER_NOT_FOUND');
        return;
      }
      const expectedStatus = supportedRecoveryEvent
        ? AccountStatus.ACTIVE
        : AccountStatus.PENDING_VERIFICATION;
      if (user.status !== expectedStatus) {
        await this.markPublished(message.id);
        return;
      }

      if (supportedRecoveryEvent) {
        const issued = await this.passwordResetTokens.issue(userId);
        await this.deliveries.recordQueued({
          sourceEventId: message.id,
          userId,
          type: NotificationDeliveryType.PASSWORD_RECOVERY,
          correlationId: message.correlationId,
        });
        const delivery: PasswordRecoveryDeliveryPayload = {
          version: 1,
          recipient: user.emailNormalized,
          passwordResetUrl: `${this.profile.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(issued.token)}`,
          expiresAt: issued.expiresAt.toISOString(),
        };
        const job: PasswordRecoveryJobData = {
          version: 1,
          sourceEventId: message.id,
          correlationId: message.correlationId,
          userId,
          encryptedDelivery: encryptQueueMessage(
            delivery,
            this.profile.MESSAGE_ENCRYPTION_KEY_BASE64,
          ),
        };

        await this.publisher.publishPasswordRecovery(job);
        await this.markPublished(message.id);
        return;
      }

      const issued = await this.verificationTokens.issue(userId);
      await this.deliveries.recordQueued({
        sourceEventId: message.id,
        userId,
        type: NotificationDeliveryType.EMAIL_VERIFICATION,
        correlationId: message.correlationId,
      });
      const delivery: EmailVerificationDeliveryPayload = {
        version: 1,
        recipient: user.emailNormalized,
        verificationUrl: `${this.profile.WEB_ORIGIN}/verify-email?token=${encodeURIComponent(issued.token)}`,
        expiresAt: issued.expiresAt.toISOString(),
      };
      const job: EmailVerificationJobData = {
        version: 1,
        sourceEventId: message.id,
        correlationId: message.correlationId,
        userId,
        encryptedDelivery: encryptQueueMessage(
          delivery,
          this.profile.MESSAGE_ENCRYPTION_KEY_BASE64,
        ),
      };

      await this.publisher.publishEmailVerification(job);
      await this.markPublished(message.id);
    } catch {
      await this.releaseAfterFailure(message);
    }
  }

  private async markPublished(messageId: string): Promise<void> {
    const updated = await this.prisma.outboxMessage.updateMany({
      where: {
        id: messageId,
        status: OutboxMessageStatus.PENDING,
        claimedBy: this.relayId,
      },
      data: {
        status: OutboxMessageStatus.PUBLISHED,
        publishedAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        lastError: null,
      },
    });
    if (updated.count !== 1) throw new Error('Claimed outbox message could not be published.');
  }

  private async deadLetter(messageId: string, errorCode: string): Promise<void> {
    await this.prisma.outboxMessage.updateMany({
      where: {
        id: messageId,
        status: OutboxMessageStatus.PENDING,
        claimedBy: this.relayId,
      },
      data: {
        status: OutboxMessageStatus.DEAD_LETTER,
        attemptCount: { increment: 1 },
        lastError: errorCode,
        deadLetteredAt: new Date(),
        claimedAt: null,
        claimedBy: null,
      },
    });
  }

  private async releaseAfterFailure(message: ClaimedOutboxMessage): Promise<void> {
    const attempt = message.attemptCount + 1;
    if (attempt >= MAX_PUBLICATION_ATTEMPTS) {
      await this.deadLetter(message.id, 'QUEUE_PUBLICATION_FAILED');
      return;
    }

    await this.prisma.outboxMessage.updateMany({
      where: {
        id: message.id,
        status: OutboxMessageStatus.PENDING,
        claimedBy: this.relayId,
      },
      data: {
        attemptCount: attempt,
        lastError: 'QUEUE_PUBLICATION_FAILED',
        availableAt: new Date(Date.now() + calculateOutboxRetryDelayMs(attempt)),
        claimedAt: null,
        claimedBy: null,
      },
    });
  }
}
