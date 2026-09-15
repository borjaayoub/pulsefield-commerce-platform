import type Stripe from 'stripe';
import { PaymentWebhookEventType } from '../generated/prisma/enums';
import { STRIPE_API_VERSION } from './payment-webhook.constants';
import { StripeWebhookRequestError } from './payment-webhook.errors';

export interface NormalizedStripeWebhook {
  providerEventId: string;
  eventType: PaymentWebhookEventType;
  providerObjectId: string;
  apiVersion: typeof STRIPE_API_VERSION;
  livemode: false;
  providerCreatedAt: Date;
  normalizedData: {
    schemaVersion: 1;
    paymentAttemptId: string;
    orderReference: string;
    amountMinor: number;
    currencyCode: 'USD';
    paymentStatus: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  };
}

const EVENT_STATUS = {
  'payment_intent.processing': PaymentWebhookEventType.PROCESSING,
  'payment_intent.succeeded': PaymentWebhookEventType.SUCCEEDED,
  'payment_intent.payment_failed': PaymentWebhookEventType.FAILED,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeStripeWebhook(event: Stripe.Event): NormalizedStripeWebhook | null {
  const eventType = EVENT_STATUS[event.type as keyof typeof EVENT_STATUS];
  if (!eventType) return null;
  const object: unknown = event.data.object;
  const metadata = isRecord(object) ? object.metadata : undefined;
  const expectedProviderStatus =
    eventType === PaymentWebhookEventType.PROCESSING
      ? 'processing'
      : eventType === PaymentWebhookEventType.SUCCEEDED
        ? 'succeeded'
        : 'requires_payment_method';
  const createdAt = new Date(event.created * 1_000);
  if (
    event.object !== 'event' ||
    !/^evt_[A-Za-z0-9]{1,124}$/u.test(event.id) ||
    event.api_version !== STRIPE_API_VERSION ||
    event.livemode !== false ||
    !Number.isSafeInteger(event.created) ||
    event.created <= 0 ||
    Number.isNaN(createdAt.getTime()) ||
    !isRecord(object) ||
    object.object !== 'payment_intent' ||
    typeof object.id !== 'string' ||
    !/^pi_[A-Za-z0-9]{1,125}$/u.test(object.id) ||
    object.livemode !== false ||
    object.status !== expectedProviderStatus ||
    !Number.isSafeInteger(object.amount) ||
    (object.amount as number) < 1 ||
    object.currency !== 'usd' ||
    !isRecord(metadata) ||
    Object.keys(metadata).sort().join(',') !== 'order_reference,payment_attempt_id' ||
    typeof metadata.payment_attempt_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      metadata.payment_attempt_id,
    ) ||
    typeof metadata.order_reference !== 'string' ||
    !/^PF-[A-F0-9]{12}$/u.test(metadata.order_reference)
  ) {
    throw new StripeWebhookRequestError();
  }

  return {
    providerEventId: event.id,
    eventType,
    providerObjectId: object.id,
    apiVersion: STRIPE_API_VERSION,
    livemode: false,
    providerCreatedAt: createdAt,
    normalizedData: {
      schemaVersion: 1,
      paymentAttemptId: metadata.payment_attempt_id,
      orderReference: metadata.order_reference,
      amountMinor: object.amount as number,
      currencyCode: 'USD',
      paymentStatus: eventType,
    },
  };
}
