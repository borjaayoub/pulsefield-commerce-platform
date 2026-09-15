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
import { PaymentAttemptStatus } from '../generated/prisma/enums';

export type ConfiguredPaymentProvider = 'stub' | 'stripe';
type PaymentAdapter = Pick<PaymentProvider, 'createPayment'> &
  Partial<Pick<PaymentProvider, 'retrievePayment' | 'refund'>>;

@Injectable()
export class PaymentApplicationService {
  constructor(
    readonly provider: ConfiguredPaymentProvider,
    private readonly adapter: PaymentAdapter,
    readonly publishableKey?: string,
  ) {}

  get initialAttemptStatus(): PaymentAttemptStatus {
    return this.provider === 'stripe'
      ? PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD
      : PaymentAttemptStatus.PROCESSING;
  }

  createPayment(input: CreatePaymentInput, context: CommandContext): Promise<PaymentResult> {
    return this.adapter.createPayment(input, context);
  }

  retrievePayment(input: RetrievePaymentInput): Promise<PaymentResult> {
    if (!this.adapter.retrievePayment) throw new Error('Payment reconciliation is unavailable.');
    return this.adapter.retrievePayment(input);
  }

  refund(input: RefundInput, context: CommandContext): Promise<RefundResult> {
    if (!this.adapter.refund) throw new Error('Payment compensation is unavailable.');
    return this.adapter.refund(input, context);
  }
}
