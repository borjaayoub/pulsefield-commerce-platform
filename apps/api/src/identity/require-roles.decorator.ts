import { SetMetadata } from '@nestjs/common';
import { RoleName } from '../generated/prisma/enums';

export const REQUIRED_ROLES_METADATA = 'pulse-field:required-roles';

export function RequireRoles(firstRole: RoleName, ...additionalRoles: RoleName[]): MethodDecorator {
  return SetMetadata(REQUIRED_ROLES_METADATA, [firstRole, ...additionalRoles]);
}
