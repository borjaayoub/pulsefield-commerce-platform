import {
  decideAuthoritativePaymentReconciliation,
  decideCompensationTransition,
  PAYMENT_COMPENSATION_STATUSES,
} from './payment-reconciliation';

const payment = {
  providerPaymentId: 'pi_authoritative',
  amountMinor: 12_345n,
  currencyCode: 'USD',
  status: 'PROCESSING' as const,
};

const succeededEvidence = {
  providerPaymentId: 'pi_authoritative',
  amountMinor: 12_345n,
  currencyCode: 'USD',
  status: 'SUCCEEDED',
};

describe('payment compensation lifecycle', () => {
  it.each([
    ['REQUIRED', 'PROCESSING'],
    ['PROCESSING', 'SUCCEEDED'],
    ['PROCESSING', 'FAILED'],
  ] as const)('applies %s -> %s', (currentStatus, evidenceStatus) => {
    expect(decideCompensationTransition(currentStatus, evidenceStatus)).toEqual({
      outcome: 'APPLY',
      nextStatus: evidenceStatus,
    });
  });

  it.each(PAYMENT_COMPENSATION_STATUSES)('treats repeated %s evidence as a no-op', (status) => {
    expect(decideCompensationTransition(status, status)).toEqual({
      outcome: 'NO_OP',
      nextStatus: status,
    });
  });

  it('retains skipped and terminal-reversing evidence for reconciliation', () => {
    expect(decideCompensationTransition('REQUIRED', 'SUCCEEDED')).toMatchObject({
      outcome: 'RECONCILIATION_REQUIRED',
      reason: 'OUT_OF_ORDER_EVIDENCE',
    });
    expect(decideCompensationTransition('SUCCEEDED', 'FAILED')).toMatchObject({
      outcome: 'RECONCILIATION_REQUIRED',
      reason: 'TERMINAL_REVERSAL',
    });
  });

  it('rejects unsupported evidence', () => {
    expect(decideCompensationTransition('PROCESSING', 'CANCELED')).toEqual({
      outcome: 'TERMINAL_FAILURE',
      reason: 'UNSUPPORTED_EVIDENCE',
    });
  });
});

describe('authoritative payment reconciliation', () => {
  it('applies a validated in-order authoritative transition', () => {
    expect(
      decideAuthoritativePaymentReconciliation(
        { payment, paymentFailureCode: null, reservationStatus: 'ACTIVE' },
        succeededEvidence,
      ),
    ).toEqual({ outcome: 'APPLY_AUTHORITATIVE_PAYMENT', nextStatus: 'SUCCEEDED' });
  });

  it('permits a validated skipped-forward success only after authoritative retrieval', () => {
    expect(
      decideAuthoritativePaymentReconciliation(
        {
          payment: { ...payment, status: 'REQUIRES_PAYMENT_METHOD' },
          paymentFailureCode: null,
          reservationStatus: 'ACTIVE',
        },
        succeededEvidence,
      ),
    ).toEqual({ outcome: 'APPLY_AUTHORITATIVE_PAYMENT', nextStatus: 'SUCCEEDED' });
  });

  it('selects late-success recovery for an attempt failed by reservation expiry', () => {
    expect(
      decideAuthoritativePaymentReconciliation(
        {
          payment: { ...payment, status: 'FAILED' },
          paymentFailureCode: 'RESERVATION_EXPIRED',
          reservationStatus: 'EXPIRED',
        },
        succeededEvidence,
      ),
    ).toEqual({ outcome: 'LATE_SUCCESS_RECOVERY', action: 'TRY_SINGLE_RERESERVATION' });
  });

  it('completes matching authoritative state as a no-op', () => {
    expect(
      decideAuthoritativePaymentReconciliation(
        {
          payment: { ...payment, status: 'SUCCEEDED' },
          paymentFailureCode: null,
          reservationStatus: 'COMMITTED',
        },
        succeededEvidence,
      ),
    ).toEqual({ outcome: 'COMPLETE_NO_OP' });
  });

  it('retains backward, contradictory, and inactive-reservation evidence', () => {
    expect(
      decideAuthoritativePaymentReconciliation(
        {
          payment: { ...payment, status: 'SUCCEEDED' },
          paymentFailureCode: null,
          reservationStatus: 'COMMITTED',
        },
        { ...succeededEvidence, status: 'FAILED' },
      ),
    ).toEqual({ outcome: 'RETAIN_FOR_REVIEW', reason: 'BACKWARD_OR_CONTRADICTORY' });
    expect(
      decideAuthoritativePaymentReconciliation(
        { payment, paymentFailureCode: null, reservationStatus: 'RELEASED' },
        succeededEvidence,
      ),
    ).toEqual({ outcome: 'RETAIN_FOR_REVIEW', reason: 'INACTIVE_RESERVATION' });
  });

  it('rejects inconsistent identity, money, currency, and unsupported evidence', () => {
    for (const evidence of [
      { ...succeededEvidence, providerPaymentId: 'pi_other' },
      { ...succeededEvidence, amountMinor: 12_346n },
      { ...succeededEvidence, currencyCode: 'EUR' },
      { ...succeededEvidence, status: 'CANCELED' },
    ]) {
      expect(
        decideAuthoritativePaymentReconciliation(
          { payment, paymentFailureCode: null, reservationStatus: 'ACTIVE' },
          evidence,
        ),
      ).toMatchObject({ outcome: 'REJECT_EVIDENCE' });
    }
    expect(
      decideAuthoritativePaymentReconciliation(
        {
          payment: { ...payment, providerPaymentId: null },
          paymentFailureCode: null,
          reservationStatus: 'ACTIVE',
        },
        succeededEvidence,
      ),
    ).toEqual({ outcome: 'REJECT_EVIDENCE', reason: 'INCONSISTENT_EVIDENCE' });
  });
});
