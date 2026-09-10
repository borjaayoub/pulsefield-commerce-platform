import { RoleName } from '../generated/prisma/enums';
import { ForbiddenError } from './authentication.errors';
import { AuthorizationService, requiresStaffMfa, roleFingerprint } from './authorization.service';

describe('AuthorizationService', () => {
  const service = new AuthorizationService();
  const actor = { id: 'actor-id', roles: [RoleName.CUSTOMER] };

  it('creates a deterministic fingerprint independent of role order and duplicates', () => {
    expect(roleFingerprint([RoleName.CUSTOMER, RoleName.FULFILLER])).toBe(
      roleFingerprint([RoleName.FULFILLER, RoleName.CUSTOMER, RoleName.CUSTOMER]),
    );
    expect(roleFingerprint([RoleName.CUSTOMER])).not.toBe(roleFingerprint([RoleName.FULFILLER]));
  });

  it('classifies administrator and fulfiller roles as staff MFA roles', () => {
    expect(requiresStaffMfa([RoleName.CUSTOMER])).toBe(false);
    expect(requiresStaffMfa([RoleName.FULFILLER])).toBe(true);
    expect(requiresStaffMfa([RoleName.ADMINISTRATOR])).toBe(true);
  });

  it('allows only explicitly named roles without an administrator bypass', () => {
    expect(() => service.assertAnyRole(actor, [RoleName.CUSTOMER])).not.toThrow();
    expect(() =>
      service.assertAnyRole({ id: 'administrator-id', roles: [RoleName.ADMINISTRATOR] }, [
        RoleName.FULFILLER,
      ]),
    ).toThrow(ForbiddenError);
    expect(() => service.assertAnyRole(actor, [])).toThrow(ForbiddenError);
  });

  it('allows the persisted owner and only explicitly allowed override roles', () => {
    expect(() => service.assertResourceAccess(actor, actor.id)).not.toThrow();
    expect(() => service.assertResourceAccess(actor, 'another-owner')).toThrow(ForbiddenError);
    expect(() =>
      service.assertResourceAccess(
        { id: 'fulfiller-id', roles: [RoleName.FULFILLER] },
        'another-owner',
        [RoleName.FULFILLER],
      ),
    ).not.toThrow();
    expect(() =>
      service.assertResourceAccess(
        { id: 'administrator-id', roles: [RoleName.ADMINISTRATOR] },
        'another-owner',
        [RoleName.FULFILLER],
      ),
    ).toThrow(ForbiddenError);
  });
});
