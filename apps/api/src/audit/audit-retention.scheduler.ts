import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { randomUUID } from 'node:crypto';
import { AUDIT_RETENTION_PROFILE } from './audit.constants';
import { AuditRetentionHeldError } from './audit.errors';
import { AuditRetentionService } from './audit-retention.service';

export const AUDIT_RETENTION_SCHEDULE_BATCH_SIZE = 250;
const AUDIT_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

@Injectable()
export class AuditRetentionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AuditRetentionScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly retention: AuditRetentionService,
    @Inject(AUDIT_RETENTION_PROFILE) private readonly profile: LocalProfile,
  ) {}

  onApplicationBootstrap(): void {
    if (this.profile.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.purgeOnce(), AUDIT_RETENTION_INTERVAL_MS);
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
      await this.retention.purgeExpired(AUDIT_RETENTION_SCHEDULE_BATCH_SIZE, {
        requestId: `request-${id}`,
        correlationId: `correlation-${id}`,
        idempotencyKey: `idempotency-${id}`,
        actor: {
          type: 'system',
          id: 'audit-retention-scheduler',
          roles: ['AUDIT_RETENTION'],
        },
        reason: 'Apply the documented audit retention policy.',
      });
    } catch (error) {
      if (error instanceof AuditRetentionHeldError) {
        this.logger.debug('Audit retention is paused by an active investigation hold.');
      } else {
        this.logger.error('Audit retention purge failed.');
      }
    } finally {
      this.running = false;
    }
  }
}
