import { validateLocalProfile } from '@pulse-field/foundation';
import Stripe from 'stripe';
import { PaymentWebhookEventType } from '../generated/prisma/enums';
import { StripeWebhookRequestError } from './payment-webhook.errors';
import { normalizeStripeWebhook } from './stripe-webhook-normalizer';
import { StripeWebhookVerifier } from './stripe-webhook-verifier';

const secret = 'whsec_local_test_secret';
const profile = validateLocalProfile({
  LOCAL_DEVELOPMENT_PROFILE: 'zero-cost-local',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://pulsefield:password@localhost:5432/pulsefield',
  QUEUE_REDIS_URL: 'redis://localhost:6379/0',
  EPHEMERAL_REDIS_URL: 'redis://localhost:6380/0',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_ALLOW_EXTERNAL: 'false',
  MESSAGE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  OUTBOX_RELAY_ENABLED: 'false',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  PRODUCT_MEDIA_ROOT: './.local/media',
  WEB_ORIGIN: 'http://localhost:3000',
  API_PORT: '4000',
  WORKER_PORT: '4001',
  PAYMENT_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_local_placeholder',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_local_placeholder',
  STRIPE_WEBHOOK_SECRET: secret,
  BILLABLE_ADAPTERS_ENABLED: 'false',
});

function eventPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_slice43test',
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: Math.floor(Date.now() / 1_000),
    livemode: false,
    type: 'payment_intent.processing',
    data: {
      object: {
        id: 'pi_slice43test',
        object: 'payment_intent',
        livemode: false,
        status: 'processing',
        amount: 12_345,
        currency: 'usd',
        metadata: {
          payment_attempt_id: '11111111-1111-4111-8111-111111111111',
          order_reference: 'PF-ABCDEF123456',
        },
      },
    },
    ...overrides,
  });
}

describe('Stripe webhook verification and normalization', () => {
  const verifier = new StripeWebhookVerifier(profile);

  it('verifies the exact raw bytes and normalizes only bounded payment evidence', () => {
    const payload = eventPayload();
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    const event = verifier.verify(Buffer.from(payload), signature);

    expect(normalizeStripeWebhook(event)).toMatchObject({
      providerEventId: 'evt_slice43test',
      eventType: PaymentWebhookEventType.PROCESSING,
      providerObjectId: 'pi_slice43test',
      livemode: false,
      normalizedData: {
        amountMinor: 12_345,
        currencyCode: 'USD',
        paymentStatus: 'PROCESSING',
      },
    });
    expect(JSON.stringify(normalizeStripeWebhook(event))).not.toContain('client_secret');
  });

  it('rejects changed raw bytes and stale signatures without exposing verifier details', () => {
    const payload = eventPayload();
    const valid = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(() => verifier.verify(Buffer.from(`${payload} `), valid)).toThrow(
      StripeWebhookRequestError,
    );

    const stale = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp: Math.floor(Date.now() / 1_000) - 301,
    });
    expect(() => verifier.verify(Buffer.from(payload), stale)).toThrow(StripeWebhookRequestError);
  });

  it('ignores signed unrelated events and rejects unsafe supported evidence', () => {
    expect(
      normalizeStripeWebhook(
        JSON.parse(eventPayload({ type: 'customer.created' })) as Stripe.Event,
      ),
    ).toBeNull();
    expect(() =>
      normalizeStripeWebhook(JSON.parse(eventPayload({ livemode: true })) as Stripe.Event),
    ).toThrow(StripeWebhookRequestError);
    expect(() =>
      normalizeStripeWebhook(
        JSON.parse(eventPayload({ api_version: '2026-08-27' })) as Stripe.Event,
      ),
    ).toThrow(StripeWebhookRequestError);
  });
});
