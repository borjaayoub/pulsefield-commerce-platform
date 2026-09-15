import { DynamicModule, Global, Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { AuditModule } from '../audit/audit.module';
import { PaymentsModule } from '../payments/payments.module';
import { OrdersModule } from '../orders/orders.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';

@Global()
@Module({})
export class CheckoutModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: CheckoutModule,
      imports: [AuditModule, PaymentsModule.forRoot(profile), OrdersModule.forRoot(profile)],
      controllers: [CheckoutController],
      providers: [CheckoutService],
    };
  }
}
