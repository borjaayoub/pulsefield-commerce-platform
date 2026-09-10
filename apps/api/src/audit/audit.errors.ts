export class InvalidCommandContextError extends Error {
  readonly code = 'COMMAND_CONTEXT_INVALID';

  constructor() {
    super('The command context is invalid.');
  }
}

export class UnsafeAuditMetadataError extends Error {
  readonly code = 'AUDIT_METADATA_UNSAFE';

  constructor() {
    super('The audit metadata is unsafe.');
  }
}

export class AuditAccessDeniedError extends Error {
  constructor() {
    super('Audit history access is not allowed.');
  }
}

export class InvalidAuditQueryError extends Error {
  constructor() {
    super('The audit query is invalid.');
  }
}

export class AuditRetentionHeldError extends Error {
  constructor() {
    super('Audit retention is paused by an active investigation hold.');
  }
}

export class AuditRetentionConflictError extends Error {
  constructor() {
    super('The audit retention state changed before this operation completed.');
  }
}
