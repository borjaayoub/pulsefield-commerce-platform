import {
  decidePaymentEvidence,
  type NormalizedPaymentEvidence,
  type PaymentAttemptLifecycleStatus,
  type PaymentAttemptSnapshot,
} from './payment-lifecycle';

export const PAYMENT_COMPENSATION_STATUSES = [
  'REQUIRED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
] as const;

export type PaymentCompensationLifecycleStatus = (typeof PAYMENT_COMPENSATION_STATUSES)[number];

export type CompensationTransitionDecision =
  | { outcome: 'APPLY'; nextStatus: PaymentCompensationLifecycleStatus }
  | { outcome: 'NO_OP'; nextStatus: PaymentCompensationLifecycleStatus }
  | {
      outcome: 'RECONCILIATION_REQUIRED';
      currentStatus: PaymentCompensationLifecycleStatus;
      evidenceStatus: PaymentCompensationLifecycleStatus;
      reason: 'TERMINAL_REVERSAL' | 'OUT_OF_ORDER_EVIDENCE';
    }
  | { outcome: 'TERMINAL_FAILURE'; reason: 'UNSUPPORTED_EVIDENCE' };

export interface PaymentReconciliationSnapshot {
  payment: PaymentAttemptSnapshot;
  paymentFailureCode: string | null;
  reservationStatus: 'ACTIVE' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';
}

export type PaymentReconciliationDecision =
  | { outcome: 'APPLY_AUTHORITATIVE_PAYMENT'; nextStatus: PaymentAttemptLifecycleStatus }
  | { outcome: 'COMPLETE_NO_OP' }
  | { outcome: 'LATE_SUCCESS_RECOVERY'; action: 'TRY_SINGLE_RERESERVATION' }
  | {
      outcome: 'RETAIN_FOR_REVIEW';
      reason: 'BACKWARD_OR_CONTRADICTORY' | 'INACTIVE_RESERVATION';
    }
  | { outcome: 'REJECT_EVIDENCE'; reason: 'UNSUPPORTED_EVIDENCE' | 'INCONSISTENT_EVIDENCE' };

const TERMINAL_COMPENSATION_STATUSES = new Set<PaymentCompensationLifecycleStatus>([
  'SUCCEEDED',
  'FAILED',
]);

export function decideCompensationTransition(
  currentStatus: PaymentCompensationLifecycleStatus,
  evidenceStatus: unknown,
): CompensationTransitionDecision {
  if (!isPaymentCompensationStatus(evidenceStatus)) {
    return { outcome: 'TERMINAL_FAILURE', reason: 'UNSUPPORTED_EVIDENCE' };
  }
  if (currentStatus === evidenceStatus) return { outcome: 'NO_OP', nextStatus: currentStatus };
  if (TERMINAL_COMPENSATION_STATUSES.has(currentStatus)) {
    return {
      outcome: 'RECONCILIATION_REQUIRED',
      currentStatus,
      evidenceStatus,
      reason: 'TERMINAL_REVERSAL',
    };
  }
  if (
    (currentStatus === 'REQUIRED' && evidenceStatus === 'PROCESSING') ||
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

export function decideAuthoritativePaymentReconciliation(
  current: PaymentReconciliationSnapshot,
  evidence: NormalizedPaymentEvidence,
): PaymentReconciliationDecision {
  if (current.payment.providerPaymentId === null) {
    return { outcome: 'REJECT_EVIDENCE', reason: 'INCONSISTENT_EVIDENCE' };
  }
  const transition = decidePaymentEvidence(current.payment, evidence);
  if (transition.outcome === 'TERMINAL_FAILURE') {
    return { outcome: 'REJECT_EVIDENCE', reason: transition.reason };
  }

  if (
    evidence.status === 'SUCCEEDED' &&
    current.reservationStatus === 'EXPIRED' &&
    current.payment.status === 'FAILED' &&
    current.paymentFailureCode === 'RESERVATION_EXPIRED'
  ) {
    return { outcome: 'LATE_SUCCESS_RECOVERY', action: 'TRY_SINGLE_RERESERVATION' };
  }

  if (transition.outcome === 'NO_OP') return { outcome: 'COMPLETE_NO_OP' };

  if (
    transition.outcome === 'RECONCILIATION_REQUIRED' &&
    (current.payment.status === 'SUCCEEDED' || current.payment.status === 'FAILED')
  ) {
    return { outcome: 'RETAIN_FOR_REVIEW', reason: 'BACKWARD_OR_CONTRADICTORY' };
  }

  if (current.reservationStatus !== 'ACTIVE') {
    return { outcome: 'RETAIN_FOR_REVIEW', reason: 'INACTIVE_RESERVATION' };
  }

  if (transition.outcome === 'APPLY') {
    return { outcome: 'APPLY_AUTHORITATIVE_PAYMENT', nextStatus: transition.nextStatus };
  }

  if (current.payment.status === 'REQUIRES_PAYMENT_METHOD' && evidence.status === 'SUCCEEDED') {
    return { outcome: 'APPLY_AUTHORITATIVE_PAYMENT', nextStatus: 'SUCCEEDED' };
  }

  return { outcome: 'RETAIN_FOR_REVIEW', reason: 'BACKWARD_OR_CONTRADICTORY' };
}

function isPaymentCompensationStatus(value: unknown): value is PaymentCompensationLifecycleStatus {
  return (
    typeof value === 'string' &&
    (PAYMENT_COMPENSATION_STATUSES as readonly string[]).includes(value)
  );
}
