import { StubPaymentProvider } from './stub-payment.provider';

describe('StubPaymentProvider', () => {
  const provider = new StubPaymentProvider();
  const input = {
    orderId: '00000000-0000-4000-8000-000000000001',
    amount: { amountMinor: 1234n, currency: 'USD' as const },
    metadata: { orderReference: 'PF-TEST' },
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
});
