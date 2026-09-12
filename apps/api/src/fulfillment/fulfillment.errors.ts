export class FulfillmentRequestError extends Error {
  readonly code = 'REQUEST_VALIDATION_FAILED';

  constructor() {
    super('Request validation failed.');
  }
}

export type FulfillmentConflictCode =
  | 'FULFILLMENT_REVISION_REQUIRED'
  | 'FULFILLMENT_REVISION_CONFLICT'
  | 'FULFILLMENT_TRANSITION_INVALID'
  | 'FULFILLMENT_UNAVAILABLE'
  | 'FULFILLMENT_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REQUIRED';

export class FulfillmentConflictError extends Error {
  constructor(
    readonly code: FulfillmentConflictCode,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
  }
}
