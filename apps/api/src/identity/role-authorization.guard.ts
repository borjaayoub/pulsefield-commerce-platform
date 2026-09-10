import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RoleName } from '../generated/prisma/enums';
import { ForbiddenError, UnauthenticatedError } from './authentication.errors';
import { AuthorizationService } from './authorization.service';
import { REQUIRED_ROLES_METADATA } from './require-roles.decorator';
import type { AuthenticatedSessionRequest } from './session-authentication.guard';

@Injectable()
export class RoleAuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedSessionRequest>();
    if (!request.authenticatedSession) throw new UnauthenticatedError();

    const requiredRoles = this.reflector.getAllAndOverride<readonly RoleName[]>(
      REQUIRED_ROLES_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles) throw new ForbiddenError();

    this.authorization.assertAnyRole(
      {
        id: request.authenticatedSession.user.id,
        roles: request.authenticatedSession.user.roles,
      },
      requiredRoles,
    );
    return true;
  }
}
