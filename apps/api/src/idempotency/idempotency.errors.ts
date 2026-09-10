export class InvalidIdempotencyInputError extends Error {
  constructor() {
    super('Idempotency input is invalid.');
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used for different input.');
  }
}

export class IdempotencyClaimLostError extends Error {
  constructor() {
    super('The idempotency claim is no longer owned by this attempt.');
  }
}

export class IdempotencyRetentionConflictError extends Error {
  constructor() {
    super('Idempotency retention cannot be completed safely.');
  }
}
