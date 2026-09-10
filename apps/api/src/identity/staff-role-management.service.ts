import { Injectable } from '@nestjs/common';
import type { AuditedCommandContext } from '../audit/command-context';
import { normalizeAuditedCommandContext } from '../audit/command-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { ForbiddenError } from './authentication.errors';
import { MANAGEABLE_STAFF_ROLES } from './staff-role.dto';

export interface StaffRoleAssignmentView {
  userId: string;
  roles: RoleName[];
}

function sortedRoles(roles: readonly RoleName[]): RoleName[] {
  return [...new Set(roles)].sort();
}

@Injectable()
export class StaffRoleManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  grant(
    userId: string,
    role: (typeof MANAGEABLE_STAFF_ROLES)[number],
    context: AuditedCommandContext,
  ): Promise<StaffRoleAssignmentView> {
    return this.change('grant', userId, role, context);
  }

  revoke(
    userId: string,
    role: (typeof MANAGEABLE_STAFF_ROLES)[number],
    context: AuditedCommandContext,
  ): Promise<StaffRoleAssignmentView> {
    return this.change('revoke', userId, role, context);
  }

  private async change(
    operation: 'grant' | 'revoke',
    userId: string,
    role: (typeof MANAGEABLE_STAFF_ROLES)[number],
    context: AuditedCommandContext,
  ): Promise<StaffRoleAssignmentView> {
    const command = normalizeAuditedCommandContext(context);
    if (
      !command.actor.roles.includes(RoleName.ADMINISTRATOR) ||
      command.actor.id === userId ||
      !MANAGEABLE_STAFF_ROLES.includes(role)
    ) {
      throw new ForbiddenError();
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(734821947)`;

      const actor = await transaction.user.findUnique({
        where: { id: command.actor.id },
        select: {
          status: true,
          verifiedAt: true,
          userRoles: { select: { role: true } },
        },
      });
      if (
        !actor ||
        actor.status !== AccountStatus.ACTIVE ||
        !actor.verifiedAt ||
        !actor.userRoles.some(({ role: actorRole }) => actorRole === RoleName.ADMINISTRATOR)
      ) {
        throw new ForbiddenError();
      }

      const target = await transaction.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          status: true,
          verifiedAt: true,
          userRoles: { select: { role: true } },
        },
      });
      if (!target || target.status !== AccountStatus.ACTIVE || !target.verifiedAt) {
        throw new ForbiddenError();
      }

      const beforeRoles = sortedRoles(target.userRoles.map(({ role: current }) => current));
      const alreadyAssigned = beforeRoles.includes(role);
      if (
        (operation === 'grant' && alreadyAssigned) ||
        (operation === 'revoke' && !alreadyAssigned)
      ) {
        return { userId: target.id, roles: beforeRoles };
      }

      if (operation === 'revoke' && role === RoleName.ADMINISTRATOR) {
        const administratorCount = await transaction.userRole.count({
          where: { role: RoleName.ADMINISTRATOR },
        });
        if (administratorCount <= 1) throw new ForbiddenError();
      }

      if (operation === 'grant') {
        await transaction.userRole.create({ data: { userId: target.id, role } });
      } else {
        await transaction.userRole.delete({
          where: { userId_role: { userId: target.id, role } },
        });
      }
      await transaction.user.update({
        where: { id: target.id },
        data: { credentialVersion: { increment: 1 } },
      });

      const afterRoles = sortedRoles(
        operation === 'grant'
          ? [...beforeRoles, role]
          : beforeRoles.filter((current) => current !== role),
      );
      await this.audit.append(
        transaction,
        {
          action: `identity.staff-role.${operation === 'grant' ? 'granted' : 'revoked'}`,
          targetType: 'identity.user',
          targetId: target.id,
          beforeMetadata: { roles: beforeRoles },
          afterMetadata: { roles: afterRoles },
        },
        context,
      );

      return { userId: target.id, roles: afterRoles };
    });
  }
}
