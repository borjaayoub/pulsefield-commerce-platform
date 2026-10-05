import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { PaymentCompensationStatus } from '../generated/prisma/enums';
import { PaymentApplicationService } from './payment-application.service';

export class PaymentCompensationConflictError extends Error {
  readonly code = 'PAYMENT_COMPENSATION_CONFLICT';

  constructor() {
    super('The payment compensation could not be applied safely.');
  }
}

export type PaymentCompensationExecutionResult = {
  outcome: 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'NO_OP';
};

function conflict(): never {
  throw new PaymentCompensationConflictError();
}

@Injectable()
export class PaymentCompensationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentApplicationService,
    private readonly audit: AuditService,
  ) {}

  async execute(
    compensationId: string,
    requestId: string,
  ): Promise<PaymentCompensationExecutionResult> {
    const candidate = await this.prisma.paymentCompensation.findUnique({
      where: { id: compensationId },
      include: { paymentAttempt: true },
    });
    if (
      !candidate ||
      candidate.provider !== this.payments.provider ||
      (candidate.currencyCode !== 'USD' &&
        candidate.currencyCode !== 'MAD' &&
        candidate.currencyCode !== 'EUR' &&
        candidate.currencyCode !== 'GBP') ||
      (candidate.provider === 'stripe' && candidate.currencyCode !== 'USD')
    )
      conflict();
    if (
      candidate.status === PaymentCompensationStatus.SUCCEEDED ||
      candidate.status === PaymentCompensationStatus.FAILED
    ) {
      return { outcome: 'NO_OP' };
    }
    if (!candidate.paymentAttempt.providerPaymentId) conflict();

    const result = await this.payments.refund(
      {
        paymentId: candidate.paymentAttempt.providerPaymentId,
        amount: { amountMinor: candidate.amountMinor, currency: candidate.currencyCode },
        reason: 'late_success_stock_unavailable',
      },
      {
        idempotencyKey: `payment-compensation-${candidate.id}`,
        requestId,
        correlationId: requestId,
        actor: { type: 'system', id: 'payment-compensation', roles: [] },
      },
    );

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PaymentCompensation" WHERE "id" = ${candidate.id} FOR UPDATE`;
        let current = await tx.paymentCompensation.findUnique({ where: { id: candidate.id } });
        if (!current) conflict();
        if (
          current.status === PaymentCompensationStatus.SUCCEEDED ||
          current.status === PaymentCompensationStatus.FAILED
        ) {
          return { outcome: 'NO_OP' } as const;
        }
        const now = new Date();
        if (current.status === PaymentCompensationStatus.REQUIRED) {
          current = await tx.paymentCompensation.update({
            where: { id: current.id },
            data: {
              status: PaymentCompensationStatus.PROCESSING,
              providerCompensationId: result.refundId,
              processingStartedAt: now,
            },
          });
        } else if (current.providerCompensationId !== result.refundId) {
          conflict();
        }
        if (result.status === 'processing') return { outcome: 'PROCESSING' } as const;
        const terminalStatus =
          result.status === 'succeeded'
            ? PaymentCompensationStatus.SUCCEEDED
            : PaymentCompensationStatus.FAILED;
        await tx.paymentCompensation.update({
          where: { id: current.id },
          data: {
            status: terminalStatus,
            completedAt: now,
            ...(terminalStatus === PaymentCompensationStatus.FAILED
              ? { failureCode: 'PROVIDER_REFUND_FAILED' }
              : {}),
          },
        });
        await this.audit.append(
          tx,
          {
            action:
              terminalStatus === PaymentCompensationStatus.SUCCEEDED
                ? 'commerce.payment.compensation-succeeded'
                : 'commerce.payment.compensation-failed',
            targetType: 'payment-compensation',
            targetId: current.id,
            afterMetadata: { outcome: result.status },
          },
          {
            idempotencyKey: `payment-compensation-outcome-${current.id}`,
            requestId,
            correlationId: requestId,
            actor: { type: 'system', id: 'payment-compensation', roles: [] },
            reason: 'Apply verified provider compensation evidence.',
          },
        );
        await tx.outboxMessage.create({
          data: {
            eventType:
              terminalStatus === PaymentCompensationStatus.SUCCEEDED
                ? 'commerce.payment.compensation-succeeded'
                : 'commerce.payment.compensation-failed',
            eventVersion: 1,
            aggregateType: 'paymentCompensation',
            aggregateId: current.id,
            payload: {
              compensationId: current.id,
              orderId: current.orderId,
              outcome: result.status,
            },
            correlationId: requestId,
          },
        });
        return { outcome: result.status.toUpperCase() } as PaymentCompensationExecutionResult;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
