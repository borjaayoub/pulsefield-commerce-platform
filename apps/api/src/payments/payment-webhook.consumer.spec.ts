import { UnrecoverableError } from 'bullmq';
import { parsePaymentWebhookJob } from './payment-webhook.consumer';
import { PAYMENT_WEBHOOK_JOB_OPTIONS, paymentWebhookJobId } from './payment-webhook.publisher';
import { ensureCompensationSettled } from './payment-webhook.processor';

describe('payment webhook queue contracts', () => {
  it('accepts only the versioned UUID-only job body', () => {
    const inboxId = '11111111-1111-4111-8111-111111111111';
    expect(parsePaymentWebhookJob({ version: 1, inboxId })).toEqual({ version: 1, inboxId });
    expect(() => parsePaymentWebhookJob({ version: 1, inboxId, payload: {} })).toThrow(
      UnrecoverableError,
    );
    expect(() => parsePaymentWebhookJob({ version: 2, inboxId })).toThrow(UnrecoverableError);
  });

  it('creates deterministic BullMQ-safe job IDs', () => {
    const jobId = paymentWebhookJobId('11111111-1111-4111-8111-111111111111', 3);
    expect(jobId).toBe('payment-webhook-11111111-1111-4111-8111-111111111111-3');
    expect(jobId).not.toContain(':');
  });

  it('retries uncertain provider reconciliation with bounded exponential backoff', () => {
    expect(PAYMENT_WEBHOOK_JOB_OPTIONS).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnFail: true,
    });
  });

  it('keeps still-processing compensation retryable and accepts terminal evidence', () => {
    expect(() => ensureCompensationSettled({ outcome: 'PROCESSING' })).toThrow('remains pending');
    expect(() => ensureCompensationSettled({ outcome: 'SUCCEEDED' })).not.toThrow();
  });
});
