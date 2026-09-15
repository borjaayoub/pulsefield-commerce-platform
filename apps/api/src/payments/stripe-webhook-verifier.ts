import type { LocalProfile } from '@pulse-field/foundation';
import Stripe from 'stripe';
import {
  PAYMENT_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  STRIPE_API_VERSION,
} from './payment-webhook.constants';
import { StripeWebhookRequestError } from './payment-webhook.errors';

export interface StripeWebhookClient {
  webhooks: Pick<Stripe['webhooks'], 'constructEvent'>;
}

export class StripeWebhookVerifier {
  private readonly stripe: StripeWebhookClient;
  private readonly signingSecret: string;

  constructor(profile: LocalProfile, stripe?: StripeWebhookClient) {
    if (!profile.STRIPE_SECRET_KEY || !profile.STRIPE_WEBHOOK_SECRET) {
      throw new Error('Stripe webhook configuration is incomplete.');
    }
    this.signingSecret = profile.STRIPE_WEBHOOK_SECRET;
    this.stripe =
      stripe ??
      new Stripe(profile.STRIPE_SECRET_KEY, {
        apiVersion: STRIPE_API_VERSION,
        timeout: 10_000,
        maxNetworkRetries: 2,
      });
  }

  verify(rawBody: Buffer, signature: string | undefined): Stripe.Event {
    if (!signature || signature.length > 8_192 || rawBody.length === 0) {
      throw new StripeWebhookRequestError();
    }
    try {
      return this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.signingSecret,
        PAYMENT_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      );
    } catch {
      throw new StripeWebhookRequestError();
    }
  }
}
