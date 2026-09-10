export class InvalidCredentialsError extends Error {
  readonly name = 'InvalidCredentialsError';
  readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Email or password is invalid.');
  }
}

export class UnauthenticatedError extends Error {
  readonly name = 'UnauthenticatedError';
  readonly code = 'UNAUTHENTICATED';

  constructor() {
    super('A valid session is required.');
  }
}

export class ForbiddenError extends Error {
  readonly name = 'ForbiddenError';
  readonly code = 'FORBIDDEN';

  constructor() {
    super('You are not allowed to perform this action.');
  }
}

export class InvalidCsrfTokenError extends Error {
  readonly name = 'InvalidCsrfTokenError';
  readonly code = 'INVALID_CSRF_TOKEN';

  constructor() {
    super('The CSRF token is invalid or unavailable.');
  }
}

export class CrossSiteRequestError extends Error {
  readonly name = 'CrossSiteRequestError';
  readonly code = 'CROSS_SITE_REQUEST_REJECTED';

  constructor() {
    super('The browser request origin is not allowed.');
  }
}

export class SessionStoreUnavailableError extends Error {
  readonly name = 'SessionStoreUnavailableError';
  readonly code = 'SESSION_STORE_UNAVAILABLE';

  constructor() {
    super('The session service is unavailable.');
  }
}

export class MfaAuthenticationFailedError extends Error {
  readonly name = 'MfaAuthenticationFailedError';
  readonly code = 'MFA_AUTHENTICATION_FAILED';

  constructor() {
    super('The MFA challenge or authentication code is invalid or unavailable.');
  }
}

export class MfaServiceUnavailableError extends Error {
  readonly name = 'MfaServiceUnavailableError';
  readonly code = 'MFA_SERVICE_UNAVAILABLE';

  constructor() {
    super('MFA handling is temporarily unavailable.');
  }
}

export class RecentAuthenticationRequiredError extends Error {
  readonly name = 'RecentAuthenticationRequiredError';
  readonly code = 'RECENT_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Recent password and MFA authentication is required.');
  }
}

export class StaffAccountNotFoundError extends Error {
  readonly name = 'StaffAccountNotFoundError';
  readonly code = 'STAFF_ACCOUNT_NOT_FOUND';

  constructor() {
    super('The requested account was not found.');
  }
}

export class NotificationDeliveryReplayUnavailableError extends Error {
  readonly name = 'NotificationDeliveryReplayUnavailableError';
  readonly code = 'NOTIFICATION_DELIVERY_REPLAY_UNAVAILABLE';

  constructor() {
    super('The notification delivery is not available for replay.');
  }
}
