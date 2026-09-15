export class StripeWebhookRequestError extends Error {
  readonly code = 'STRIPE_WEBHOOK_REJECTED';

  constructor() {
    super('The webhook request was rejected.');
  }
}

export class StripeWebhookPersistenceUnavailableError extends Error {
  readonly code = 'STRIPE_WEBHOOK_PERSISTENCE_UNAVAILABLE';

  constructor() {
    super('Webhook persistence is temporarily unavailable.');
  }
}
