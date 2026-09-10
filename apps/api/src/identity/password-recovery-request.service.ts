import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus } from '../generated/prisma/enums';
import { normalizeEmail } from './normalize-email';

export const PASSWORD_RECOVERY_REQUEST_EVENT_TYPE = 'identity.password-recovery.requested';
export const PASSWORD_RECOVERY_REQUEST_EVENT_VERSION = 1;
export const PASSWORD_RECOVERY_REQUEST_COOLDOWN_MS = 15 * 60 * 1000;

export interface RequestPasswordRecoveryContext {
  correlationId?: string;
  causationId?: string;
}

@Injectable()
export class PasswordRecoveryRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async request(email: string, context: RequestPasswordRecoveryContext = {}): Promise<void> {
    const emailNormalized = normalizeEmail(email);
    const requestedAt = new Date();
    const eligibleBefore = new Date(requestedAt.getTime() - PASSWORD_RECOVERY_REQUEST_COOLDOWN_MS);
    const outboxMessageId = randomUUID();
    const correlationId = context.correlationId ?? outboxMessageId;

    await this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.findUnique({
        where: { emailNormalized },
        select: { id: true },
      });

      if (!user) return;

      const claimed = await transaction.user.updateMany({
        where: {
          id: user.id,
          status: AccountStatus.ACTIVE,
          OR: [
            { passwordRecoveryRequestedAt: null },
            { passwordRecoveryRequestedAt: { lte: eligibleBefore } },
          ],
        },
        data: { passwordRecoveryRequestedAt: requestedAt },
      });

      if (claimed.count !== 1) return;

      await transaction.outboxMessage.create({
        data: {
          id: outboxMessageId,
          eventType: PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
          eventVersion: PASSWORD_RECOVERY_REQUEST_EVENT_VERSION,
          aggregateType: 'User',
          aggregateId: user.id,
          payload: { userId: user.id },
          correlationId,
          causationId: context.causationId,
        },
      });
    });
  }
}
