import {
  decidePaymentEvidence,
  decidePaymentTransition,
  PAYMENT_ATTEMPT_STATUSES,
} from './payment-lifecycle';

describe('payment attempt lifecycle', () => {
  it.each([
    ['REQUIRES_PAYMENT_METHOD', 'PROCESSING'],
    ['REQUIRES_PAYMENT_METHOD', 'FAILED'],
    ['PROCESSING', 'SUCCEEDED'],
    ['PROCESSING', 'FAILED'],
  ] as const)('applies %s -> %s', (currentStatus, evidenceStatus) => {
    expect(decidePaymentTransition(currentStatus, evidenceStatus)).toEqual({
      outcome: 'APPLY',
      nextStatus: evidenceStatus,
    });
  });

  it.each(PAYMENT_ATTEMPT_STATUSES)('treats repeated %s evidence as a no-op', (status) => {
    expect(decidePaymentTransition(status, status)).toEqual({
      outcome: 'NO_OP',
      nextStatus: status,
    });
  });

  it.each([
    ['SUCCEEDED', 'FAILED'],
    ['FAILED', 'SUCCEEDED'],
    ['SUCCEEDED', 'PROCESSING'],
    ['FAILED', 'REQUIRES_PAYMENT_METHOD'],
  ] as const)('flags terminal reversal %s -> %s for reconciliation', (current, evidence) => {
    expect(decidePaymentTransition(current, evidence)).toEqual({
      outcome: 'RECONCILIATION_REQUIRED',
      currentStatus: current,
      evidenceStatus: evidence,
      reason: 'TERMINAL_REVERSAL',
    });
  });

  it.each([
    ['REQUIRES_PAYMENT_METHOD', 'SUCCEEDED'],
    ['PROCESSING', 'REQUIRES_PAYMENT_METHOD'],
  ] as const)('does not apply out-of-order evidence %s -> %s', (current, evidence) => {
    expect(decidePaymentTransition(current, evidence)).toEqual({
      outcome: 'RECONCILIATION_REQUIRED',
      currentStatus: current,
      evidenceStatus: evidence,
      reason: 'OUT_OF_ORDER_EVIDENCE',
    });
  });

  it('turns unknown provider evidence into a safe terminal inbox outcome', () => {
    expect(decidePaymentTransition('PROCESSING', 'CANCELED')).toEqual({
      outcome: 'TERMINAL_FAILURE',
      reason: 'UNSUPPORTED_EVIDENCE',
    });
  });

  it.each([
    { providerPaymentId: 'pi_other', amountMinor: 1000n, currencyCode: 'USD' },
    { providerPaymentId: 'pi_expected', amountMinor: 1001n, currencyCode: 'USD' },
    { providerPaymentId: 'pi_expected', amountMinor: 1000n, currencyCode: 'EUR' },
  ])(
    'rejects inconsistent provider identity and money evidence without a transition',
    (evidence) => {
      expect(
        decidePaymentEvidence(
          {
            providerPaymentId: 'pi_expected',
            amountMinor: 1000n,
            currencyCode: 'USD',
            status: 'PROCESSING',
          },
          { ...evidence, status: 'SUCCEEDED' },
        ),
      ).toEqual({ outcome: 'TERMINAL_FAILURE', reason: 'INCONSISTENT_EVIDENCE' });
    },
  );
});
