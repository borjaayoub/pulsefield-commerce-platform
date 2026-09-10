import { Injectable } from '@nestjs/common';
import type { AuditedCommandContext } from '../audit/command-context';
import { normalizeAuditedCommandContext } from '../audit/command-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { ForbiddenError, StaffAccountNotFoundError } from './authentication.errors';
import { normalizeEmail } from './normalize-email';
import type { MaskedStaffAccountDto } from './staff-account-lookup.dto';
import { maskEmailForStaffView } from './staff-email-mask';

@Injectable()
export class StaffAccountLookupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findByEmail(email: string, context: AuditedCommandContext): Promise<MaskedStaffAccountDto> {
    const command = normalizeAuditedCommandContext(context);
    if (!command.actor.roles.includes(RoleName.ADMINISTRATOR)) throw new ForbiddenError();
    const emailNormalized = normalizeEmail(email);

    return this.prisma.$transaction(async (transaction) => {
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
        !actor.userRoles.some(({ role }) => role === RoleName.ADMINISTRATOR)
      ) {
        throw new ForbiddenError();
      }

      const user = await transaction.user.findUnique({
        where: { emailNormalized },
        select: {
          id: true,
          emailNormalized: true,
          status: true,
          verifiedAt: true,
          userRoles: { select: { role: true } },
        },
      });
      if (!user) throw new StaffAccountNotFoundError();

      await this.audit.append(
        transaction,
        {
          action: 'identity.staff-account.viewed',
          targetType: 'identity.user',
          targetId: user.id,
        },
        context,
      );

      return {
        userId: user.id,
        emailMasked: maskEmailForStaffView(user.emailNormalized),
        status: user.status,
        verified: user.verifiedAt !== null,
        roles: [...new Set(user.userRoles.map(({ role }) => role))].sort(),
      };
    });
  }
}
