import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus } from '../generated/prisma/enums';
import { normalizeEmail } from './normalize-email';

export const EMAIL_VERIFICATION_REQUEST_EVENT_TYPE = 'identity.email-verification.requested';
export const EMAIL_VERIFICATION_REQUEST_EVENT_VERSION = 1;
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 5 * 60 * 1000;

export interface RequestEmailVerificationContext {
  correlationId?: string;
  causationId?: string;
}

@Injectable()
export class EmailVerificationRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async request(email: string, context: RequestEmailVerificationContext = {}): Promise<void> {
    const emailNormalized = normalizeEmail(email);
    const requestedAt = new Date();
    const eligibleBefore = new Date(requestedAt.getTime() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MS);
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
          status: AccountStatus.PENDING_VERIFICATION,
          OR: [
            { verificationEmailRequestedAt: null },
            { verificationEmailRequestedAt: { lte: eligibleBefore } },
          ],
        },
        data: { verificationEmailRequestedAt: requestedAt },
      });

      if (claimed.count !== 1) return;

      await transaction.outboxMessage.create({
        data: {
          id: outboxMessageId,
          eventType: EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
          eventVersion: EMAIL_VERIFICATION_REQUEST_EVENT_VERSION,
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
