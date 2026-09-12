export class ReservationExpiryConflictError extends Error {
  constructor() {
    super('The reservation could not be expired safely.');
  }
}

export class ReservationExpirySweepError extends Error {
  readonly code = 'RESERVATION_EXPIRY_SWEEP_PARTIAL_FAILURE';

  constructor(
    readonly expiredCount: number,
    readonly failedCount: number,
  ) {
    super('One or more reservation expiry candidates could not be processed.');
  }
}
