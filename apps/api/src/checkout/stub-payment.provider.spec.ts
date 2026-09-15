import { StubPaymentProvider } from '../payments/stub-payment.provider';

describe('StubPaymentProvider', () => {
  const provider = new StubPaymentProvider();
  const input = {
    orderId: '00000000-0000-4000-8000-000000000001',
    amount: { amountMinor: 1234n, currency: 'USD' as const },
    metadata: { paymentAttemptId: 'attempt-test', orderReference: 'PF-TEST' },
  };

  it('returns a deterministic local success without payment data', async () => {
    await expect(
      provider.createPayment({ ...input, paymentMethodReference: 'stub-success' }),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', paymentId: expect.stringMatching(/^stub_/u) }),
    );
  });

  it('returns a deterministic local decline', async () => {
    await expect(
      provider.createPayment({ ...input, paymentMethodReference: 'stub-decline' }),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'failed', paymentId: expect.stringMatching(/^stub_/u) }),
    );
  });

  it('reconstructs only matching deterministic evidence during reconciliation', async () => {
    const created = await provider.createPayment({
      ...input,
      paymentMethodReference: 'stub-success',
    });
    await expect(
      provider.retrievePayment({
        ...input,
        paymentId: created.paymentId,
        paymentMethodReference: 'stub-success',
      }),
    ).resolves.toEqual(created);
    await expect(
      provider.retrievePayment({
        ...input,
        paymentId: 'stub_tampered',
        paymentMethodReference: 'stub-success',
      }),
    ).rejects.toThrow('inconsistent');
  });
});
