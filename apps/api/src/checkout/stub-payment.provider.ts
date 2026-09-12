import { Injectable } from '@nestjs/common';
import type { CreatePaymentInput, PaymentProvider, PaymentResult } from '@pulse-field/contracts';
import { createHash } from 'node:crypto';

/** Non-networked Phase 3 demo provider. It accepts no card data. */
@Injectable()
export class StubPaymentProvider implements Pick<PaymentProvider, 'createPayment'> {
  async createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    const suffix = createHash('sha256')
      .update(`${input.orderId}:${input.paymentMethodReference}`)
      .digest('hex')
      .slice(0, 20);
    return input.paymentMethodReference === 'stub-success'
      ? { paymentId: `stub_${suffix}`, status: 'succeeded' }
      : { paymentId: `stub_${suffix}`, status: 'failed' };
  }
}
