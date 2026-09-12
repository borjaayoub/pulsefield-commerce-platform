import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import {
  RESERVATION_EXPIRY_BATCH_SIZE,
  ReservationExpiryService,
} from './reservation-expiry.service';
import { ReservationExpirySweepError } from './reservation-expiry.errors';

export const RESERVATION_EXPIRY_PROFILE = Symbol('RESERVATION_EXPIRY_PROFILE');
export const RESERVATION_EXPIRY_INTERVAL_MS = 60_000;

@Injectable()
export class ReservationExpiryScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReservationExpiryScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly expiry: ReservationExpiryService,
    @Inject(RESERVATION_EXPIRY_PROFILE) private readonly profile: LocalProfile,
  ) {}

  onApplicationBootstrap(): void {
    if (this.profile.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.runOnce(), RESERVATION_EXPIRY_INTERVAL_MS);
    this.timer.unref();
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.expiry.sweepExpired(RESERVATION_EXPIRY_BATCH_SIZE);
    } catch (error) {
      if (error instanceof ReservationExpirySweepError) {
        this.logger.warn(
          `Reservation expiry sweep had ${error.failedCount} failed candidate(s) after ${error.expiredCount} success(es).`,
        );
      } else {
        this.logger.warn('Reservation expiry sweep failed.');
      }
    } finally {
      this.running = false;
    }
  }
}
