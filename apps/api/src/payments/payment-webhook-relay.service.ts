import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { PrismaService } from '../database/prisma.service';
import { PaymentWebhookInboxStatus } from '../generated/prisma/enums';
import {
  PAYMENT_PROFILE,
  PAYMENT_WEBHOOK_MAX_ATTEMPTS,
  PAYMENT_WEBHOOK_POLL_INTERVAL_MS,
  PAYMENT_WEBHOOK_PUBLISHER,
} from './payment-webhook.constants';
import type { PaymentWebhookPublisher } from './payment-webhook.publisher';

@Injectable()
export class PaymentWebhookRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentWebhookRelayService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_WEBHOOK_PUBLISHER) private readonly publisher: PaymentWebhookPublisher,
    @Inject(PAYMENT_PROFILE) private readonly profile: LocalProfile,
  ) {}

  onApplicationBootstrap(): void {
    if (this.profile.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.poll(), PAYMENT_WEBHOOK_POLL_INTERVAL_MS);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async drainOnce(): Promise<boolean> {
    await this.recoverExpiredClaims();
    const pending = await this.prisma.paymentWebhookInbox.findFirst({
      where: { provider: 'stripe', status: PaymentWebhookInboxStatus.PENDING },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, processingAttempts: true },
    });
    if (!pending) return false;
    await this.publisher.publish(
      { version: 1, inboxId: pending.id },
      pending.processingAttempts + 1,
    );
    return true;
  }

  private async recoverExpiredClaims(): Promise<void> {
    const now = new Date();
    await this.prisma.paymentWebhookInbox.updateMany({
      where: {
        provider: 'stripe',
        status: PaymentWebhookInboxStatus.PROCESSING,
        processingAttempts: { gte: PAYMENT_WEBHOOK_MAX_ATTEMPTS },
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: PaymentWebhookInboxStatus.TERMINAL_FAILURE,
        claimTokenDigest: null,
        leaseExpiresAt: null,
        processedAt: now,
        failureCode: 'PROCESSING_ATTEMPTS_EXHAUSTED',
      },
    });
    await this.prisma.paymentWebhookInbox.updateMany({
      where: {
        provider: 'stripe',
        status: PaymentWebhookInboxStatus.PROCESSING,
        processingAttempts: { lt: PAYMENT_WEBHOOK_MAX_ATTEMPTS },
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: PaymentWebhookInboxStatus.PENDING,
        claimTokenDigest: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    });
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.drainOnce();
    } catch {
      this.logger.error('Payment webhook relay poll failed.');
    } finally {
      this.running = false;
    }
  }
}
