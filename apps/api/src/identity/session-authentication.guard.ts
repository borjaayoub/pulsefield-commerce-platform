import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthenticatedError } from './authentication.errors';
import { readSessionCookie } from './session-cookie';
import { SessionService, type SessionView } from './session.service';

export interface AuthenticatedSessionRequest extends Request {
  authenticatedSession?: SessionView;
}

@Injectable()
export class SessionAuthenticationGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedSessionRequest>();
    const sessionId = readSessionCookie(request);
    if (!sessionId) {
      throw new UnauthenticatedError();
    }

    request.authenticatedSession = await this.sessions.current(sessionId);
    return true;
  }
}
