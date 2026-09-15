export const PAYMENT_ATTEMPT_STATUSES = [
  'REQUIRES_PAYMENT_METHOD',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
] as const;

export type PaymentAttemptLifecycleStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

export type PaymentTransitionDecision =
  | { outcome: 'APPLY'; nextStatus: PaymentAttemptLifecycleStatus }
  | { outcome: 'NO_OP'; nextStatus: PaymentAttemptLifecycleStatus }
  | {
      outcome: 'RECONCILIATION_REQUIRED';
      currentStatus: PaymentAttemptLifecycleStatus;
      evidenceStatus: PaymentAttemptLifecycleStatus;
      reason: 'TERMINAL_REVERSAL' | 'OUT_OF_ORDER_EVIDENCE';
    }
  | {
      outcome: 'TERMINAL_FAILURE';
      reason: 'UNSUPPORTED_EVIDENCE' | 'INCONSISTENT_EVIDENCE';
    };

export interface PaymentAttemptSnapshot {
  providerPaymentId: string | null;
  amountMinor: bigint;
  currencyCode: string;
  status: PaymentAttemptLifecycleStatus;
}

export interface NormalizedPaymentEvidence {
  providerPaymentId: string;
  amountMinor: bigint;
  currencyCode: string;
  status: unknown;
}

const TERMINAL_STATUSES = new Set<PaymentAttemptLifecycleStatus>(['SUCCEEDED', 'FAILED']);

export function decidePaymentTransition(
  currentStatus: PaymentAttemptLifecycleStatus,
  evidenceStatus: unknown,
): PaymentTransitionDecision {
  if (!isPaymentAttemptStatus(evidenceStatus)) {
    return { outcome: 'TERMINAL_FAILURE', reason: 'UNSUPPORTED_EVIDENCE' };
  }

  if (currentStatus === evidenceStatus) {
    return { outcome: 'NO_OP', nextStatus: currentStatus };
  }

  if (TERMINAL_STATUSES.has(currentStatus)) {
    return {
      outcome: 'RECONCILIATION_REQUIRED',
      currentStatus,
      evidenceStatus,
      reason: 'TERMINAL_REVERSAL',
    };
  }

  if (
    (currentStatus === 'REQUIRES_PAYMENT_METHOD' &&
      (evidenceStatus === 'PROCESSING' || evidenceStatus === 'FAILED')) ||
    (currentStatus === 'PROCESSING' &&
      (evidenceStatus === 'SUCCEEDED' || evidenceStatus === 'FAILED'))
  ) {
    return { outcome: 'APPLY', nextStatus: evidenceStatus };
  }

  return {
    outcome: 'RECONCILIATION_REQUIRED',
    currentStatus,
    evidenceStatus,
    reason: 'OUT_OF_ORDER_EVIDENCE',
  };
}

export function decidePaymentEvidence(
  attempt: PaymentAttemptSnapshot,
  evidence: NormalizedPaymentEvidence,
): PaymentTransitionDecision {
  if (!isPaymentAttemptStatus(evidence.status)) {
    return { outcome: 'TERMINAL_FAILURE', reason: 'UNSUPPORTED_EVIDENCE' };
  }

  if (
    evidence.providerPaymentId.length === 0 ||
    (attempt.providerPaymentId !== null &&
      attempt.providerPaymentId !== evidence.providerPaymentId) ||
    attempt.amountMinor !== evidence.amountMinor ||
    attempt.currencyCode !== evidence.currencyCode
  ) {
    return { outcome: 'TERMINAL_FAILURE', reason: 'INCONSISTENT_EVIDENCE' };
  }

  return decidePaymentTransition(attempt.status, evidence.status);
}

function isPaymentAttemptStatus(value: unknown): value is PaymentAttemptLifecycleStatus {
  return (
    typeof value === 'string' && (PAYMENT_ATTEMPT_STATUSES as readonly string[]).includes(value)
  );
}
