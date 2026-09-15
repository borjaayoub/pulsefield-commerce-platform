import { DynamicModule, Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { GUEST_ORDER_ACCESS_KEY } from './guest-order-access';
import { OrdersController } from './orders.controller';
import { OrderTimelineService } from './order-timeline.service';

@Module({})
export class OrdersModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [OrdersController],
      providers: [
        { provide: GUEST_ORDER_ACCESS_KEY, useValue: profile.MESSAGE_ENCRYPTION_KEY_BASE64 },
        OrderTimelineService,
      ],
      exports: [OrderTimelineService],
    };
  }
}
