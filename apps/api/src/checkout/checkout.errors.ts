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
