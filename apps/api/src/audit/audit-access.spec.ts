import { AuditAccessDeniedError } from './audit.errors';
import { assertAuditReader, type AuditReaderContext } from './audit-access';

describe('assertAuditReader', () => {
  const now = new Date('2026-09-03T15:00:00.000Z');

  function context(): AuditReaderContext {
    return {
      actor: { type: 'staff', id: 'administrator-1', roles: ['ADMINISTRATOR'] },
      authenticationAssurance: 'PASSWORD_MFA',
      authenticatedAt: new Date('2026-09-03T14:55:00.000Z'),
    };
  }

  it('allows a recently MFA-authenticated administrator', () => {
    expect(() => assertAuditReader(context(), now)).not.toThrow();
  });

  it.each([
    { actor: { type: 'customer', id: 'customer-1', roles: ['CUSTOMER'] } },
    { actor: { type: 'staff', id: 'fulfiller-1', roles: ['FULFILLER'] } },
    { authenticationAssurance: 'PASSWORD' },
    { authenticatedAt: new Date('2026-09-03T14:49:59.999Z') },
    { authenticatedAt: new Date('2026-09-03T15:00:00.001Z') },
  ])('denies insufficient or stale authority %#', (change) => {
    expect(() => assertAuditReader({ ...context(), ...change } as AuditReaderContext, now)).toThrow(
      AuditAccessDeniedError,
    );
  });
});
