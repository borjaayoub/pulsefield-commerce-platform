import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  PaymentAttemptStatus,
  PaymentWebhookEventType,
  PaymentWebhookInboxStatus,
  ReservationStatus,
} from '../generated/prisma/enums';
import { decidePaymentEvidence } from './payment-lifecycle';
import { PaymentOutcomeConflictError, PaymentOutcomeService } from './payment-outcome.service';
import { PAYMENT_WEBHOOK_CLAIM_LEASE_MS } from './payment-webhook.constants';
import {
  PaymentCompensationService,
  type PaymentCompensationExecutionResult,
} from './payment-compensation.service';
import { PaymentReconciliationExecutionService } from './payment-reconciliation-execution.service';

interface ClaimedWebhook {
  inboxId: string;
  token: string;
}

export class PaymentReconciliationPendingError extends Error {
  constructor() {
    super('Payment reconciliation remains pending.');
  }
}

export function ensureCompensationSettled(result: PaymentCompensationExecutionResult): void {
  if (result.outcome === 'PROCESSING') throw new PaymentReconciliationPendingError();
}

interface StoredEvidence {
  schemaVersion: 1;
  paymentAttemptId: string;
  orderReference: string;
  amountMinor: number;
  currencyCode: 'USD';
  paymentStatus: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseStoredEvidence(value: unknown): StoredEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  const schemaVersion = Reflect.get(value, 'schemaVersion');
  const paymentAttemptId = Reflect.get(value, 'paymentAttemptId');
  const orderReference = Reflect.get(value, 'orderReference');
  const amountMinor = Reflect.get(value, 'amountMinor');
  const currencyCode = Reflect.get(value, 'currencyCode');
  const paymentStatus = Reflect.get(value, 'paymentStatus');
  if (
    keys !==
      'amountMinor,currencyCode,orderReference,paymentAttemptId,paymentStatus,schemaVersion' ||
    schemaVersion !== 1 ||
    typeof paymentAttemptId !== 'string' ||
    typeof orderReference !== 'string' ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 1 ||
    currencyCode !== 'USD' ||
    (paymentStatus !== 'PROCESSING' && paymentStatus !== 'SUCCEEDED' && paymentStatus !== 'FAILED')
  ) {
    return null;
  }
  return {
    schemaVersion,
    paymentAttemptId,
    orderReference,
    amountMinor,
    currencyCode,
    paymentStatus,
  };
}

@Injectable()
export class PaymentWebhookProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outcomes: PaymentOutcomeService,
    private readonly reconciliation: PaymentReconciliationExecutionService,
    private readonly compensations: PaymentCompensationService,
  ) {}

  async consume(inboxId: string): Promise<void> {
    const claim = await this.claim(inboxId);
    if (!claim) {
      await this.resumeReconciliation(inboxId);
      return;
    }
    try {
      const paymentAttemptId = await this.process(claim);
      if (paymentAttemptId) await this.executeReconciliation(paymentAttemptId, inboxId);
    } catch (error) {
      if (error instanceof PaymentOutcomeConflictError) {
        await this.completeTerminal(claim, 'RECONCILIATION_REQUIRED');
        await this.resumeReconciliation(inboxId);
        return;
      }
      throw error;
    }
  }

  private async claim(inboxId: string): Promise<ClaimedWebhook | null> {
    const candidate = await this.prisma.paymentWebhookInbox.findUnique({
      where: { id: inboxId },
      select: { status: true, processingAttempts: true },
    });
    if (!candidate || candidate.status !== PaymentWebhookInboxStatus.PENDING) return null;
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const changed = await this.prisma.paymentWebhookInbox.updateMany({
      where: {
        id: inboxId,
        provider: 'stripe',
        status: PaymentWebhookInboxStatus.PENDING,
        processingAttempts: candidate.processingAttempts,
      },
      data: {
        status: PaymentWebhookInboxStatus.PROCESSING,
        processingAttempts: { increment: 1 },
        claimTokenDigest: digest(token),
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + PAYMENT_WEBHOOK_CLAIM_LEASE_MS),
      },
    });
    return changed.count === 1 ? { inboxId, token } : null;
  }

  private async process(claim: ClaimedWebhook): Promise<string | null> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PaymentWebhookInbox" WHERE "id" = ${claim.inboxId} FOR UPDATE`;
        const inbox = await tx.paymentWebhookInbox.findUnique({ where: { id: claim.inboxId } });
        if (
          !inbox ||
          inbox.status !== PaymentWebhookInboxStatus.PROCESSING ||
          inbox.claimTokenDigest !== digest(claim.token)
        ) {
          return null;
        }
        const evidence = parseStoredEvidence(inbox.normalizedData);
        if (!evidence || evidence.paymentStatus !== inbox.eventType) {
          await this.markTerminal(tx, claim, 'INCONSISTENT_EVIDENCE');
          return null;
        }
        const attempt = await tx.paymentAttempt.findUnique({
          where: { id: evidence.paymentAttemptId },
          include: { order: { include: { reservation: true } } },
        });
        if (
          !attempt ||
          attempt.provider !== 'stripe' ||
          attempt.order.reference !== evidence.orderReference ||
          attempt.amountMinor !== BigInt(evidence.amountMinor) ||
          attempt.currencyCode !== evidence.currencyCode ||
          (attempt.providerPaymentId !== null &&
            attempt.providerPaymentId !== inbox.providerObjectId)
        ) {
          await this.markTerminal(tx, claim, 'INCONSISTENT_EVIDENCE');
          return null;
        }
        if (attempt.providerPaymentId === null) {
          const attached = await tx.paymentAttempt.updateMany({
            where: {
              id: attempt.id,
              status: PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD,
              providerPaymentId: null,
            },
            data: {
              providerPaymentId: inbox.providerObjectId,
              providerReference: inbox.providerObjectId,
            },
          });
          if (attached.count !== 1) {
            await this.markTerminal(tx, claim, 'RECONCILIATION_REQUIRED');
            return null;
          }
          attempt.providerPaymentId = inbox.providerObjectId;
        }
        const decision = decidePaymentEvidence(
          {
            providerPaymentId: attempt.providerPaymentId,
            amountMinor: attempt.amountMinor,
            currencyCode: attempt.currencyCode,
            status: attempt.status,
          },
          {
            providerPaymentId: inbox.providerObjectId,
            amountMinor: BigInt(evidence.amountMinor),
            currencyCode: evidence.currencyCode,
            status: evidence.paymentStatus,
          },
        );
        if (decision.outcome === 'RECONCILIATION_REQUIRED') {
          await this.markTerminal(tx, claim, 'RECONCILIATION_REQUIRED');
          return attempt.id;
        }
        if (decision.outcome === 'TERMINAL_FAILURE') {
          await this.markTerminal(tx, claim, 'INCONSISTENT_EVIDENCE');
          return null;
        }
        if (evidence.paymentStatus === PaymentWebhookEventType.PROCESSING) {
          if (decision.outcome === 'APPLY') {
            const changed = await tx.paymentAttempt.updateMany({
              where: { id: attempt.id, status: PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD },
              data: { status: PaymentAttemptStatus.PROCESSING },
            });
            if (changed.count !== 1) throw new PaymentOutcomeConflictError();
          }
          await this.markProcessed(tx, claim);
          return null;
        }
        const [databaseClock] = await tx.$queryRaw<Array<{ now: Date }>>`
          SELECT CURRENT_TIMESTAMP AS "now"
        `;
        if (!databaseClock) throw new PaymentOutcomeConflictError();
        if (
          decision.outcome === 'APPLY' &&
          (attempt.order.reservation.status !== ReservationStatus.ACTIVE ||
            attempt.order.reservation.expiresAt <= databaseClock.now)
        ) {
          await this.markTerminal(tx, claim, 'RECONCILIATION_REQUIRED');
          return attempt.id;
        }
        await this.outcomes.applyInTransaction(tx, {
          orderId: attempt.orderId,
          paymentAttemptId: attempt.id,
          status:
            evidence.paymentStatus === PaymentWebhookEventType.SUCCEEDED ? 'succeeded' : 'failed',
          providerPaymentId: inbox.providerObjectId,
          requestId: `webhook-${inbox.id}`,
          rejectExpiredSuccess: true,
          ...(evidence.paymentStatus === PaymentWebhookEventType.FAILED
            ? { failureCode: 'PAYMENT_DECLINED' }
            : {}),
        });
        await this.markProcessed(tx, claim);
        return null;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async resumeReconciliation(inboxId: string): Promise<void> {
    const inbox = await this.prisma.paymentWebhookInbox.findUnique({ where: { id: inboxId } });
    if (
      !inbox ||
      inbox.status !== PaymentWebhookInboxStatus.TERMINAL_FAILURE ||
      inbox.failureCode !== 'RECONCILIATION_REQUIRED'
    ) {
      return;
    }
    const evidence = parseStoredEvidence(inbox.normalizedData);
    if (evidence) await this.executeReconciliation(evidence.paymentAttemptId, inbox.id);
  }

  private async executeReconciliation(paymentAttemptId: string, inboxId: string): Promise<void> {
    const result = await this.reconciliation.reconcile(
      paymentAttemptId,
      `webhook-reconciliation-${inboxId}`,
    );
    let compensationId =
      result.outcome === 'COMPENSATION_REQUIRED' ? result.compensationId : undefined;
    if (!compensationId) {
      const compensation = await this.prisma.paymentCompensation.findUnique({
        where: { paymentAttemptId },
        select: { id: true, status: true },
      });
      if (
        compensation &&
        (compensation.status === 'REQUIRED' || compensation.status === 'PROCESSING')
      ) {
        compensationId = compensation.id;
      }
    }
    if (compensationId) {
      const compensation = await this.compensations.execute(
        compensationId,
        `webhook-compensation-${inboxId}`,
      );
      ensureCompensationSettled(compensation);
    }
  }

  private async markProcessed(tx: Prisma.TransactionClient, claim: ClaimedWebhook): Promise<void> {
    const changed = await tx.paymentWebhookInbox.updateMany({
      where: {
        id: claim.inboxId,
        status: PaymentWebhookInboxStatus.PROCESSING,
        claimTokenDigest: digest(claim.token),
      },
      data: {
        status: PaymentWebhookInboxStatus.PROCESSED,
        claimTokenDigest: null,
        leaseExpiresAt: null,
        processedAt: new Date(),
      },
    });
    if (changed.count !== 1) throw new PaymentOutcomeConflictError();
  }

  private async markTerminal(
    tx: Prisma.TransactionClient,
    claim: ClaimedWebhook,
    failureCode: 'INCONSISTENT_EVIDENCE' | 'RECONCILIATION_REQUIRED',
  ): Promise<void> {
    const changed = await tx.paymentWebhookInbox.updateMany({
      where: {
        id: claim.inboxId,
        status: PaymentWebhookInboxStatus.PROCESSING,
        claimTokenDigest: digest(claim.token),
      },
      data: {
        status: PaymentWebhookInboxStatus.TERMINAL_FAILURE,
        claimTokenDigest: null,
        leaseExpiresAt: null,
        processedAt: new Date(),
        failureCode,
      },
    });
    if (changed.count !== 1) throw new PaymentOutcomeConflictError();
  }

  private async completeTerminal(
    claim: ClaimedWebhook,
    failureCode: 'RECONCILIATION_REQUIRED',
  ): Promise<void> {
    await this.prisma.$transaction((tx) => this.markTerminal(tx, claim, failureCode));
  }
}
