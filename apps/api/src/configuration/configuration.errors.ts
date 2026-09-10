export class ConfigurationNotFoundError extends Error {
  readonly code = 'CONFIGURATION_NOT_FOUND';

  constructor() {
    super('The configuration record does not exist.');
  }
}

export class ConfigurationConflictError extends Error {
  readonly code = 'CONFIGURATION_CONFLICT';

  constructor() {
    super('The configuration changed before this operation completed.');
  }
}

export class ConfigurationTransitionError extends Error {
  readonly code = 'CONFIGURATION_TRANSITION_INVALID';

  constructor() {
    super('The configuration revision cannot perform that lifecycle transition.');
  }
}

export class InvalidFoundationConfigurationError extends Error {
  readonly code = 'FOUNDATION_CONFIGURATION_INVALID';

  constructor() {
    super('The foundation configuration is invalid.');
  }
}
