import { Injectable } from '@nestjs/common';
import type {
  CommandContext,
  CreatePaymentInput,
  PaymentProvider,
  PaymentResult,
  RefundInput,
  RefundResult,
  RetrievePaymentInput,
} from '@pulse-field/contracts';
import { createHash } from 'node:crypto';

/** Non-networked default provider. It accepts no card data or credentials. */
@Injectable()
export class StubPaymentProvider implements Pick<
  PaymentProvider,
  'createPayment' | 'retrievePayment' | 'refund'
> {
  async createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    const suffix = createHash('sha256')
      .update(`${input.orderId}:${input.paymentMethodReference}`)
      .digest('hex')
      .slice(0, 20);
    return input.paymentMethodReference === 'stub-success'
      ? { paymentId: `stub_${suffix}`, status: 'succeeded' }
      : { paymentId: `stub_${suffix}`, status: 'failed' };
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<PaymentResult> {
    const result = await this.createPayment({
      orderId: input.orderId,
      amount: input.amount,
      paymentMethodReference: input.paymentMethodReference,
      metadata: input.metadata,
    });
    if (result.paymentId !== input.paymentId) {
      throw new Error('Payment provider evidence is inconsistent.');
    }
    return result;
  }

  async refund(input: RefundInput, context: CommandContext): Promise<RefundResult> {
    const suffix = createHash('sha256')
      .update(`${input.paymentId}:${input.amount.amountMinor}:${context.idempotencyKey}`)
      .digest('hex')
      .slice(0, 20);
    return { refundId: `stub_refund_${suffix}`, status: 'succeeded' };
  }
}
