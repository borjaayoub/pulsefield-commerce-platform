export class RateLimitStorageUnavailableError extends Error {
  readonly name = 'RateLimitStorageUnavailableError';
  readonly code = 'RATE_LIMIT_STORAGE_UNAVAILABLE';

  constructor() {
    super('The request abuse-control service is unavailable.');
  }
}
