import type {
  CommandContext,
  CreatePaymentInput,
  PaymentProvider,
  PaymentResult,
  RefundInput,
  RefundResult,
  RetrievePaymentInput,
} from '@pulse-field/contracts';
import type Stripe from 'stripe';

type PaymentIntent = Pick<
  Stripe.PaymentIntent,
  | 'id'
  | 'amount'
  | 'capture_method'
  | 'client_secret'
  | 'currency'
  | 'livemode'
  | 'metadata'
  | 'payment_method_types'
  | 'status'
>;

type Refund = Pick<
  Stripe.Refund,
  'id' | 'amount' | 'currency' | 'metadata' | 'payment_intent' | 'status'
>;

export interface StripePaymentIntentsClient {
  paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options: Stripe.RequestOptions,
    ): Promise<PaymentIntent>;
    retrieve(id: string): Promise<PaymentIntent>;
  };
  refunds: {
    create(params: Stripe.RefundCreateParams, options: Stripe.RequestOptions): Promise<Refund>;
  };
}

export class PaymentProviderRejectedError extends Error {
  constructor() {
    super('The payment provider rejected the request.');
  }
}

export class PaymentProviderUnavailableError extends Error {
  readonly code = 'PAYMENT_PROVIDER_UNAVAILABLE';

  constructor() {
    super('Payment setup is temporarily unavailable. Try again later.');
  }
}

function isDefiniteRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('type' in error)) return false;
  const type = (error as { type?: unknown }).type;
  return type === 'StripeInvalidRequestError' || type === 'StripeCardError';
}

function validateIntent(
  intent: PaymentIntent,
  input: Pick<CreatePaymentInput, 'amount' | 'metadata'>,
  requireClientSecret: boolean,
): void {
  const metadata = input.metadata;
  const metadataKeys = Object.keys(intent.metadata).sort();
  const expectedKeys = ['order_reference', 'payment_attempt_id'];
  if (
    !/^pi_[A-Za-z0-9]+$/u.test(intent.id) ||
    intent.livemode ||
    intent.amount !== Number(input.amount.amountMinor) ||
    intent.currency !== 'usd' ||
    intent.capture_method !== 'automatic_async' ||
    intent.payment_method_types.length !== 1 ||
    intent.payment_method_types[0] !== 'card' ||
    metadataKeys.join(',') !== expectedKeys.join(',') ||
    intent.metadata.payment_attempt_id !== metadata.paymentAttemptId ||
    intent.metadata.order_reference !== metadata.orderReference ||
    (requireClientSecret &&
      (typeof intent.client_secret !== 'string' || intent.client_secret.length === 0))
  ) {
    throw new PaymentProviderUnavailableError();
  }
}

function mapPaymentStatus(status: PaymentIntent['status']): PaymentResult['status'] {
  if (status === 'requires_payment_method') return 'requires_payment_method';
  if (status === 'processing') return 'processing';
  if (status === 'succeeded') return 'succeeded';
  if (status === 'canceled') return 'failed';
  throw new PaymentProviderUnavailableError();
}

export class StripePaymentProvider implements Pick<
  PaymentProvider,
  'createPayment' | 'retrievePayment' | 'refund'
> {
  constructor(private readonly stripe: StripePaymentIntentsClient) {}

  async createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    try {
      const amount = Number(input.amount.amountMinor);
      if (!Number.isSafeInteger(amount) || amount < 1) {
        throw new PaymentProviderUnavailableError();
      }
      const intent = input.providerPaymentId
        ? await this.stripe.paymentIntents.retrieve(input.providerPaymentId)
        : await this.stripe.paymentIntents.create(
            {
              amount,
              currency: 'usd',
              payment_method_types: ['card'],
              capture_method: 'automatic_async',
              confirmation_method: 'automatic',
              metadata: {
                payment_attempt_id: input.metadata.paymentAttemptId,
                order_reference: input.metadata.orderReference,
              },
            },
            { idempotencyKey: `pf-payment-create-${input.metadata.paymentAttemptId}` },
          );
      if (input.providerPaymentId && intent.id !== input.providerPaymentId) {
        throw new PaymentProviderUnavailableError();
      }
      validateIntent(intent, input, true);
      return {
        paymentId: intent.id,
        status: 'requires_payment_method',
        clientSecret: intent.client_secret!,
      };
    } catch (error) {
      if (error instanceof PaymentProviderUnavailableError) throw error;
      if (isDefiniteRejection(error)) throw new PaymentProviderRejectedError();
      throw new PaymentProviderUnavailableError();
    }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<PaymentResult> {
    try {
      const intent = await this.stripe.paymentIntents.retrieve(input.paymentId);
      if (intent.id !== input.paymentId) throw new PaymentProviderUnavailableError();
      validateIntent(intent, input, false);
      return { paymentId: intent.id, status: mapPaymentStatus(intent.status) };
    } catch (error) {
      if (error instanceof PaymentProviderUnavailableError) throw error;
      if (isDefiniteRejection(error)) throw new PaymentProviderRejectedError();
      throw new PaymentProviderUnavailableError();
    }
  }

  async refund(input: RefundInput, context: CommandContext): Promise<RefundResult> {
    try {
      const amount = Number(input.amount.amountMinor);
      if (!Number.isSafeInteger(amount) || amount < 1 || input.amount.currency !== 'USD') {
        throw new PaymentProviderUnavailableError();
      }
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: input.paymentId,
          amount,
          metadata: { pulse_field_reason: input.reason },
        },
        { idempotencyKey: context.idempotencyKey },
      );
      const paymentIntentId =
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : refund.payment_intent?.id;
      if (
        !/^re_[A-Za-z0-9]+$/u.test(refund.id) ||
        refund.amount !== amount ||
        refund.currency !== 'usd' ||
        paymentIntentId !== input.paymentId ||
        !refund.metadata ||
        Object.keys(refund.metadata).sort().join(',') !== 'pulse_field_reason' ||
        refund.metadata.pulse_field_reason !== input.reason
      ) {
        throw new PaymentProviderUnavailableError();
      }
      const status: RefundResult['status'] =
        refund.status === 'succeeded'
          ? 'succeeded'
          : refund.status === 'failed' || refund.status === 'canceled'
            ? 'failed'
            : refund.status === 'pending' || refund.status === 'requires_action'
              ? 'processing'
              : (() => {
                  throw new PaymentProviderUnavailableError();
                })();
      return { refundId: refund.id, status };
    } catch (error) {
      if (error instanceof PaymentProviderUnavailableError) throw error;
      if (isDefiniteRejection(error)) throw new PaymentProviderRejectedError();
      throw new PaymentProviderUnavailableError();
    }
  }
}
