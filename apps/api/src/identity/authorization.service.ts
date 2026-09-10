import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RoleName } from '../generated/prisma/enums';
import { ForbiddenError } from './authentication.errors';

export interface AuthorizationActor {
  id: string;
  roles: readonly RoleName[];
}

export const STAFF_ROLES = [RoleName.ADMINISTRATOR, RoleName.FULFILLER] as const;

export function requiresStaffMfa(roles: readonly RoleName[]): boolean {
  return roles.some((role) => STAFF_ROLES.includes(role as (typeof STAFF_ROLES)[number]));
}

export function roleFingerprint(roles: readonly RoleName[]): string {
  const canonicalRoles = [...new Set(roles)].sort().join('\n');
  return createHash('sha256').update(canonicalRoles, 'utf8').digest('hex');
}

@Injectable()
export class AuthorizationService {
  assertAnyRole(actor: AuthorizationActor, allowedRoles: readonly RoleName[]): void {
    if (allowedRoles.length === 0 || !actor.roles.some((role) => allowedRoles.includes(role))) {
      throw new ForbiddenError();
    }
  }

  assertResourceAccess(
    actor: AuthorizationActor,
    persistedOwnerId: string,
    allowedOverrideRoles: readonly RoleName[] = [],
  ): void {
    if (actor.id === persistedOwnerId) return;
    this.assertAnyRole(actor, allowedOverrideRoles);
  }
}
