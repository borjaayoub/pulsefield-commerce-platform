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
