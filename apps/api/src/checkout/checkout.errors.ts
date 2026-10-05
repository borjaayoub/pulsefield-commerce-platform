export class CheckoutConflictError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.code = code;
  }
}

export class CheckoutRequestError extends Error {
  readonly code = 'CHECKOUT_REQUEST_INVALID';
  constructor() {
    super('The checkout request is invalid.');
  }
}

export class CheckoutMarketMismatchError extends CheckoutConflictError {
  readonly requiredCurrency: 'USD' | 'MAD' | 'EUR' | 'GBP';
  constructor(
    readonly currentMarket: string,
    readonly requiredMarket: 'US' | 'MA' | 'EU' | 'UK',
    readonly cartRevision: number,
  ) {
    super('CART_MARKET_MISMATCH', 'Confirm the destination market on the cart before checkout.');
    this.requiredCurrency = { US: 'USD', MA: 'MAD', EU: 'EUR', UK: 'GBP' }[
      requiredMarket
    ] as typeof this.requiredCurrency;
  }
}

export class RegionalPaymentProviderUnavailableError extends Error {
  readonly code = 'REGIONAL_PAYMENT_PROVIDER_UNAVAILABLE';
  constructor() {
    super('The configured payment provider is unavailable for this market.');
  }
}

export class CheckoutPaymentUnavailableError extends Error {
  readonly code = 'PAYMENT_PROVIDER_UNAVAILABLE';

  constructor() {
    super('Payment setup is temporarily unavailable. Try again later.');
  }
}

export class CheckoutTemporarilyUnavailableError extends Error {
  readonly code = 'CHECKOUT_TEMPORARILY_UNAVAILABLE';

  constructor() {
    super(
      'Checkout is temporarily unavailable. Retry the same request with the same idempotency key.',
    );
  }
}
