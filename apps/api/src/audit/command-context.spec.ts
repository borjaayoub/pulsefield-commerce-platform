import { InvalidCommandContextError } from './audit.errors';
import { type AuditedCommandContext, normalizeAuditedCommandContext } from './command-context';

describe('normalizeAuditedCommandContext', () => {
  function context(): AuditedCommandContext {
    return {
      requestId: 'request-12345678',
      correlationId: 'correlation-12345678',
      causationId: 'causation-12345678',
      idempotencyKey: 'idempotency-12345678',
      reason: '  Correct an approved operational setting.  ',
      actor: {
        type: 'staff',
        id: ' administrator-1 ',
        roles: ['FULFILLER', 'ADMINISTRATOR', 'FULFILLER'],
      },
    };
  }

  it('normalizes actor identity, reason, and deterministic roles', () => {
    expect(normalizeAuditedCommandContext(context())).toEqual({
      requestId: 'request-12345678',
      correlationId: 'correlation-12345678',
      causationId: 'causation-12345678',
      idempotencyKey: 'idempotency-12345678',
      reason: 'Correct an approved operational setting.',
      actor: {
        type: 'staff',
        id: 'administrator-1',
        roles: ['ADMINISTRATOR', 'FULFILLER'],
      },
    });
  });

  it.each([
    { field: 'requestId', value: 'short' },
    { field: 'correlationId', value: 'spaces are unsafe' },
    { field: 'idempotencyKey', value: 'bad/key/value' },
  ])('rejects an unsafe $field', ({ field, value }) => {
    const candidate = context();
    Reflect.set(candidate, field, value);

    expect(() => normalizeAuditedCommandContext(candidate)).toThrow(InvalidCommandContextError);
  });

  it('rejects malformed roles and a missing audit reason', () => {
    const malformedRole = context();
    malformedRole.actor.roles = ['administrator'];
    const missingReason = context();
    missingReason.reason = '   ';

    expect(() => normalizeAuditedCommandContext(malformedRole)).toThrow(InvalidCommandContextError);
    expect(() => normalizeAuditedCommandContext(missingReason)).toThrow(InvalidCommandContextError);
  });

  it.each([
    'Contact customer@example.test about the correction.',
    'Call +212 612 345 678 before changing it.',
    'Use Bearer raw-credential to verify the request.',
  ])('rejects personal or credential data in an audit reason', (reason) => {
    expect(() => normalizeAuditedCommandContext({ ...context(), reason })).toThrow(
      InvalidCommandContextError,
    );
  });
});
