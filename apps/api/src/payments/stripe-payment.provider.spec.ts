import type { CreatePaymentInput } from '@pulse-field/contracts';
import {
  PaymentProviderRejectedError,
  PaymentProviderUnavailableError,
  StripePaymentProvider,
  type StripePaymentIntentsClient,
} from './stripe-payment.provider';

const input: CreatePaymentInput = {
  orderId: 'order-1',
  amount: { amountMinor: 5996n, currency: 'USD' },
  metadata: { paymentAttemptId: 'attempt-1', orderReference: 'PF-TEST00000001' },
};

function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_1234567890',
    amount: 5996,
    capture_method: 'automatic_async',
    client_secret: 'pi_1234567890_secret_example',
    currency: 'usd',
    livemode: false,
    metadata: {
      payment_attempt_id: 'attempt-1',
      order_reference: 'PF-TEST00000001',
    },
    payment_method_types: ['card'],
    status: 'requires_payment_method',
    ...overrides,
  };
}

function refund(overrides: Record<string, unknown> = {}) {
  return {
    id: 're_1234567890',
    amount: 5996,
    currency: 'usd',
    metadata: { pulse_field_reason: 'late_success_stock_unavailable' },
    payment_intent: 'pi_1234567890',
    status: 'succeeded',
    ...overrides,
  };
}

function providerWith(client: {
  create?: jest.Mock;
  retrieve?: jest.Mock;
  refund?: jest.Mock;
}): StripePaymentProvider {
  return new StripePaymentProvider({
    paymentIntents: {
      create: client.create ?? jest.fn(),
      retrieve: client.retrieve ?? jest.fn(),
    },
    refunds: { create: client.refund ?? jest.fn() },
  } as unknown as StripePaymentIntentsClient);
}

describe('StripePaymentProvider', () => {
  it('creates one card-only test PaymentIntent with server-owned metadata and idempotency', async () => {
    const create = jest.fn().mockResolvedValue(paymentIntent());
    const provider = providerWith({ create });

    await expect(provider.createPayment(input)).resolves.toEqual({
      paymentId: 'pi_1234567890',
      status: 'requires_payment_method',
      clientSecret: 'pi_1234567890_secret_example',
    });
    expect(create).toHaveBeenCalledWith(
      {
        amount: 5996,
        currency: 'usd',
        payment_method_types: ['card'],
        capture_method: 'automatic_async',
        confirmation_method: 'automatic',
        metadata: {
          payment_attempt_id: 'attempt-1',
          order_reference: 'PF-TEST00000001',
        },
      },
      { idempotencyKey: 'pf-payment-create-attempt-1' },
    );
  });

  it('retrieves the attached PaymentIntent on replay instead of creating another', async () => {
    const create = jest.fn();
    const retrieve = jest.fn().mockResolvedValue(paymentIntent());
    const provider = providerWith({ create, retrieve });

    await provider.createPayment({ ...input, providerPaymentId: 'pi_1234567890' });

    expect(retrieve).toHaveBeenCalledWith('pi_1234567890');
    expect(create).not.toHaveBeenCalled();
  });

  it('does not use a synchronous provider status as order authority', async () => {
    const provider = providerWith({
      create: jest.fn().mockResolvedValue(paymentIntent({ status: 'succeeded' })),
    });

    await expect(provider.createPayment(input)).resolves.toMatchObject({
      status: 'requires_payment_method',
    });
  });

  it('retrieves and maps authoritative PaymentIntent state after validating identity and money', async () => {
    const retrieve = jest.fn().mockResolvedValue(paymentIntent({ status: 'succeeded' }));
    const provider = providerWith({ retrieve });

    await expect(
      provider.retrievePayment({
        orderId: input.orderId,
        paymentId: 'pi_1234567890',
        amount: input.amount,
        metadata: input.metadata,
      }),
    ).resolves.toEqual({ paymentId: 'pi_1234567890', status: 'succeeded' });
    expect(retrieve).toHaveBeenCalledWith('pi_1234567890');
  });

  it('creates the exact full compensation with the durable idempotency key', async () => {
    const createRefund = jest.fn().mockResolvedValue(refund());
    const provider = providerWith({ refund: createRefund });

    await expect(
      provider.refund(
        {
          paymentId: 'pi_1234567890',
          amount: input.amount,
          reason: 'late_success_stock_unavailable',
        },
        {
          idempotencyKey: 'payment-compensation-123',
          requestId: 'request-1',
          correlationId: 'request-1',
          actor: { type: 'system', id: 'payment-compensation', roles: [] },
        },
      ),
    ).resolves.toEqual({ refundId: 're_1234567890', status: 'succeeded' });
    expect(createRefund).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_1234567890',
        amount: 5996,
        metadata: { pulse_field_reason: 'late_success_stock_unavailable' },
      },
      { idempotencyKey: 'payment-compensation-123' },
    );
  });

  it.each([
    { amount: 5997 },
    { currency: 'eur' },
    { payment_intent: 'pi_other' },
    { metadata: { pulse_field_reason: 'different' } },
    { status: 'unknown' },
  ])('rejects inconsistent compensation evidence: %o', async (override) => {
    const provider = providerWith({ refund: jest.fn().mockResolvedValue(refund(override)) });

    await expect(
      provider.refund(
        {
          paymentId: 'pi_1234567890',
          amount: input.amount,
          reason: 'late_success_stock_unavailable',
        },
        {
          idempotencyKey: 'payment-compensation-123',
          requestId: 'request-1',
          correlationId: 'request-1',
          actor: { type: 'system', id: 'payment-compensation', roles: [] },
        },
      ),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });

  it.each([
    { livemode: true },
    { amount: 5997 },
    { currency: 'eur' },
    { capture_method: 'manual' },
    { payment_method_types: ['card', 'link'] },
    { metadata: { payment_attempt_id: 'attempt-1', order_reference: 'wrong' } },
    { client_secret: null },
  ])('fails closed when the provider response violates the contract: %o', async (override) => {
    const provider = providerWith({ create: jest.fn().mockResolvedValue(paymentIntent(override)) });

    await expect(provider.createPayment(input)).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
  });

  it('classifies definite provider rejection separately from uncertain failures', async () => {
    const rejected = providerWith({
      create: jest.fn().mockRejectedValue({ type: 'StripeInvalidRequestError' }),
    });
    const uncertain = providerWith({ create: jest.fn().mockRejectedValue(new Error('timeout')) });

    await expect(rejected.createPayment(input)).rejects.toBeInstanceOf(
      PaymentProviderRejectedError,
    );
    await expect(uncertain.createPayment(input)).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
  });

  it('rejects amounts that cannot be represented safely for Stripe', async () => {
    const create = jest.fn();
    const provider = providerWith({ create });

    await expect(
      provider.createPayment({
        ...input,
        amount: { amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n, currency: 'USD' },
      }),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    expect(create).not.toHaveBeenCalled();
  });
});
