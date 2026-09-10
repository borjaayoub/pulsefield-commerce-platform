import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { normalizeEmail } from './normalize-email';
import { PasswordHasher } from './password-hasher.service';
import { validateAndNormalizePassword } from './password-policy';

export interface RegisterCustomerInput {
  email: string;
  plainPassword: string;
}

export interface CustomerRegistrationContext {
  correlationId?: string;
  causationId?: string;
}

export interface CustomerRegistrationResult {
  id: string;
  emailNormalized: string;
  status: AccountStatus;
  roles: RoleName[];
  createdAt: Date;
}

export const CUSTOMER_REGISTERED_EVENT_TYPE = 'identity.customer.registered';
export const CUSTOMER_REGISTERED_EVENT_VERSION = 1;

@Injectable()
export class CustomerRegistrationService {
  constructor(
    private readonly passwordHasher: PasswordHasher,
    private readonly prisma: PrismaService,
  ) {}

  async register(
    input: RegisterCustomerInput,
    context: CustomerRegistrationContext = {},
  ): Promise<CustomerRegistrationResult> {
    const emailNormalized = normalizeEmail(input.email);
    const emailLocalPart = emailNormalized.split('@', 1)[0] ?? '';
    const normalizedPassword = validateAndNormalizePassword(input.plainPassword, {
      relatedValues: [emailNormalized, emailLocalPart],
    });
    const passwordHash = await this.passwordHasher.hash(normalizedPassword);
    const verificationEmailRequestedAt = new Date();
    const outboxMessageId = randomUUID();
    const correlationId = context.correlationId ?? outboxMessageId;

    return this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: {
          emailNormalized,
          passwordHash,
          status: AccountStatus.PENDING_VERIFICATION,
          verificationEmailRequestedAt,
          userRoles: {
            create: {
              role: RoleName.CUSTOMER,
            },
          },
        },
        select: {
          id: true,
          emailNormalized: true,
          status: true,
          createdAt: true,
          userRoles: {
            select: {
              role: true,
            },
          },
        },
      });

      await transaction.outboxMessage.create({
        data: {
          id: outboxMessageId,
          eventType: CUSTOMER_REGISTERED_EVENT_TYPE,
          eventVersion: CUSTOMER_REGISTERED_EVENT_VERSION,
          aggregateType: 'User',
          aggregateId: user.id,
          payload: { userId: user.id },
          correlationId,
          causationId: context.causationId,
        },
      });

      return {
        id: user.id,
        emailNormalized: user.emailNormalized,
        status: user.status,
        roles: user.userRoles.map(({ role }) => role),
        createdAt: user.createdAt,
      };
    });
  }
}
