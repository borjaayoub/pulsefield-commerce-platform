import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { PAYMENT_PROVIDER } from './payment-provider.token';
import { StubPaymentProvider } from './stub-payment.provider';

@Global()
@Module({
  imports: [AuditModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, { provide: PAYMENT_PROVIDER, useClass: StubPaymentProvider }],
  exports: [PAYMENT_PROVIDER],
})
export class CheckoutModule {}
