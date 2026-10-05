export class CartRevisionRequiredError extends Error {
  readonly code = 'CART_REVISION_REQUIRED';
  constructor() {
    super('The cart revision is required for this mutation.');
  }
}

export class CartRevisionConflictError extends Error {
  readonly code = 'CART_REVISION_CONFLICT';
  constructor(readonly currentRevision?: number) {
    super('The cart changed since it was last read. Refresh and try again.');
  }
}

export class CartItemUnavailableError extends Error {
  readonly code = 'CART_ITEM_UNAVAILABLE';
  constructor(readonly availableQuantity: number) {
    super('The requested cart item is unavailable in the selected storefront.');
  }
}

export class CartRequestValidationError extends Error {
  readonly code = 'REQUEST_VALIDATION_FAILED';
  constructor() {
    super('Request validation failed.');
  }
}

export class CartCheckoutPendingError extends Error {
  readonly code = 'CART_CHECKOUT_PENDING';
  constructor() {
    super('The cart is being checked out. Try again shortly.');
  }
}

export class CartMarketPreviewStaleError extends Error {
  readonly code = 'CART_MARKET_PREVIEW_STALE';
  constructor() {
    super('Market pricing changed. Preview the market change again.');
  }
}
