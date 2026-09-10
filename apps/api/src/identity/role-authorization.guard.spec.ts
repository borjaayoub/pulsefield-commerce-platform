import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RoleName } from '../generated/prisma/enums';
import { ForbiddenError, UnauthenticatedError } from './authentication.errors';
import { AuthorizationService } from './authorization.service';
import { RoleAuthorizationGuard } from './role-authorization.guard';

describe('RoleAuthorizationGuard', () => {
  function createSubject(requiredRoles: readonly RoleName[] | undefined) {
    const request: Record<string, unknown> = {};
    const handler = () => undefined;
    class Controller {}
    const reflector = {
      getAllAndOverride: jest.fn(() => requiredRoles),
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => Controller,
    } as unknown as ExecutionContext;
    const guard = new RoleAuthorizationGuard(
      reflector as unknown as Reflector,
      new AuthorizationService(),
    );
    return { guard, request, reflector, context, handler, Controller };
  }

  it('requires authentication before evaluating role metadata', () => {
    const { guard, context, reflector } = createSubject([RoleName.CUSTOMER]);

    expect(() => guard.canActivate(context)).toThrow(UnauthenticatedError);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });

  it('denies a route that forgot to declare an authorization policy', () => {
    const { guard, request, context } = createSubject(undefined);
    request.authenticatedSession = {
      user: { id: 'user-id', email: 'user@example.test', roles: [RoleName.CUSTOMER] },
    };

    expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });

  it('allows a named role and reads method metadata before class metadata', () => {
    const { guard, request, context, reflector, handler, Controller } = createSubject([
      RoleName.CUSTOMER,
    ]);
    request.authenticatedSession = {
      user: { id: 'user-id', email: 'user@example.test', roles: [RoleName.CUSTOMER] },
    };

    expect(guard.canActivate(context)).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith('pulse-field:required-roles', [
      handler,
      Controller,
    ]);
  });

  it('denies roles outside the explicit route allowlist', () => {
    const { guard, request, context } = createSubject([RoleName.FULFILLER]);
    request.authenticatedSession = {
      user: {
        id: 'administrator-id',
        email: 'admin@example.test',
        roles: [RoleName.ADMINISTRATOR],
      },
    };

    expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });
});
