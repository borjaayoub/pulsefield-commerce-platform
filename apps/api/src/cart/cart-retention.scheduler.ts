import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CartService } from './cart.service';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class CartRetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CartRetentionScheduler.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly carts: CartService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.carts.sweepExpired().catch(() => {
        this.logger.warn('Anonymous cart retention sweep failed.');
      });
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
