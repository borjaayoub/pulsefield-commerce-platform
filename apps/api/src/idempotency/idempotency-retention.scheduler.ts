import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { randomUUID } from 'node:crypto';
import { IDEMPOTENCY_RETENTION_PROFILE } from './idempotency.constants';
import {
  IDEMPOTENCY_RETENTION_BATCH_SIZE,
  IdempotencyRetentionService,
} from './idempotency-retention.service';

const IDEMPOTENCY_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

@Injectable()
export class IdempotencyRetentionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyRetentionScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly retention: IdempotencyRetentionService,
    @Inject(IDEMPOTENCY_RETENTION_PROFILE) private readonly profile: LocalProfile,
  ) {}

  onApplicationBootstrap(): void {
    if (this.profile.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.purgeOnce(), IDEMPOTENCY_RETENTION_INTERVAL_MS);
    this.timer.unref();
    void this.purgeOnce();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async purgeOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const id = randomUUID();
      await this.retention.purgeExpired(IDEMPOTENCY_RETENTION_BATCH_SIZE, {
        requestId: `request-${id}`,
        correlationId: `correlation-${id}`,
        idempotencyKey: `idempotency-${id}`,
        actor: {
          type: 'system',
          id: 'idempotency-retention-scheduler',
          roles: ['IDEMPOTENCY_RETENTION'],
        },
        reason: 'Apply the idempotency record retention policy.',
      });
    } catch {
      this.logger.error('Idempotency retention purge failed.');
    } finally {
      this.running = false;
    }
  }
}
