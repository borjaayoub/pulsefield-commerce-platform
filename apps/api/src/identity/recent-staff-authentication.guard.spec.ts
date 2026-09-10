import type { ExecutionContext } from '@nestjs/common';
import { RoleName } from '../generated/prisma/enums';
import { RecentAuthenticationRequiredError, UnauthenticatedError } from './authentication.errors';
import {
  RECENT_STAFF_AUTHENTICATION_MS,
  RecentStaffAuthenticationGuard,
} from './recent-staff-authentication.guard';

describe('RecentStaffAuthenticationGuard', () => {
  const guard = new RecentStaffAuthenticationGuard();

  function context(authenticatedSession?: object): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ authenticatedSession }) }),
    } as unknown as ExecutionContext;
  }

  function session(authenticatedAt: number, roles: RoleName[] = [RoleName.ADMINISTRATOR]) {
    return {
      user: { id: 'staff-user', email: 'masked@example.test', roles },
      authenticatedAt: new Date(authenticatedAt).toISOString(),
      idleExpiresAt: new Date(authenticatedAt + 30 * 60 * 1000).toISOString(),
      absoluteExpiresAt: new Date(authenticatedAt + 24 * 60 * 60 * 1000).toISOString(),
      csrfToken: Buffer.alloc(32, 1).toString('base64url'),
    };
  }

  it('accepts a staff session with authentication inside the recent window', () => {
    expect(guard.canActivate(context(session(Date.now() - 60_000)))).toBe(true);
  });

  it('rejects a stale staff session', () => {
    expect(() =>
      guard.canActivate(context(session(Date.now() - RECENT_STAFF_AUTHENTICATION_MS - 1))),
    ).toThrow(RecentAuthenticationRequiredError);
  });

  it('rejects a customer session even when it is fresh', () => {
    expect(() => guard.canActivate(context(session(Date.now(), [RoleName.CUSTOMER])))).toThrow(
      RecentAuthenticationRequiredError,
    );
  });

  it('rejects a request without an authenticated session', () => {
    expect(() => guard.canActivate(context())).toThrow(UnauthenticatedError);
  });
});
