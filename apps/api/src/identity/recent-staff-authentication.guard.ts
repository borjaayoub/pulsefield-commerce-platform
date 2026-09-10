import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { requiresStaffMfa } from './authorization.service';
import { RecentAuthenticationRequiredError, UnauthenticatedError } from './authentication.errors';
import type { AuthenticatedSessionRequest } from './session-authentication.guard';

export const RECENT_STAFF_AUTHENTICATION_MS = 10 * 60 * 1000;

@Injectable()
export class RecentStaffAuthenticationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedSessionRequest>();
    const session = request.authenticatedSession;
    if (!session) throw new UnauthenticatedError();

    const authenticatedAt = Date.parse(session.authenticatedAt);
    if (
      !requiresStaffMfa(session.user.roles) ||
      !Number.isFinite(authenticatedAt) ||
      Date.now() - authenticatedAt > RECENT_STAFF_AUTHENTICATION_MS ||
      authenticatedAt > Date.now() + 5_000
    ) {
      throw new RecentAuthenticationRequiredError();
    }
    return true;
  }
}
