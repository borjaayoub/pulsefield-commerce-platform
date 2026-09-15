import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  AuditActorType,
  CartStatus,
  InventoryMovementType,
  OrderStatus,
  PaymentAttemptStatus,
  PaymentCompensationReason,
  ReservationStatus,
} from '../generated/prisma/enums';
import { PaymentApplicationService } from './payment-application.service';
import { PaymentOutcomeService } from './payment-outcome.service';
import { decideAuthoritativePaymentReconciliation } from './payment-reconciliation';

export class PaymentReconciliationConflictError extends Error {
  readonly code = 'PAYMENT_RECONCILIATION_CONFLICT';

  constructor() {
    super('The payment could not be reconciled safely.');
  }
}

export type PaymentReconciliationExecutionResult =
  | { outcome: 'APPLIED' | 'NO_OP' | 'RETAINED' | 'REJECTED' }
  | { outcome: 'LATE_SUCCESS_CONFIRMED'; recoveryReservationId: string }
  | { outcome: 'COMPENSATION_REQUIRED'; compensationId: string };

function conflict(): never {
  throw new PaymentReconciliationConflictError();
}

function normalizedStatus(status: string): PaymentAttemptStatus | null {
  if (status === 'requires_payment_method') return PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD;
  if (status === 'processing') return PaymentAttemptStatus.PROCESSING;
  if (status === 'succeeded') return PaymentAttemptStatus.SUCCEEDED;
  if (status === 'failed') return PaymentAttemptStatus.FAILED;
  return null;
}

@Injectable()
export class PaymentReconciliationExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentApplicationService,
    private readonly outcomes: PaymentOutcomeService,
    private readonly audit: AuditService,
  ) {}

  async reconcile(
    paymentAttemptId: string,
    requestId: string,
  ): Promise<PaymentReconciliationExecutionResult> {
    const candidate = await this.prisma.paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
      include: { order: { include: { reservation: true } } },
    });
    if (
      !candidate ||
      candidate.provider !== this.payments.provider ||
      candidate.providerPaymentId === null ||
      candidate.currencyCode !== 'USD'
    ) {
      return { outcome: 'REJECTED' };
    }

    const providerResult = await this.payments.retrievePayment({
      orderId: candidate.orderId,
      paymentId: candidate.providerPaymentId,
      paymentMethodReference: candidate.paymentMethodReference,
      amount: { amountMinor: candidate.amountMinor, currency: candidate.currencyCode },
      metadata: {
        paymentAttemptId: candidate.id,
        orderReference: candidate.order.reference,
      },
    });
    const evidenceStatus = normalizedStatus(providerResult.status);
    if (!evidenceStatus || providerResult.paymentId !== candidate.providerPaymentId) {
      return { outcome: 'REJECTED' };
    }

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${candidate.orderId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "InventoryReservation" WHERE "id" = ${candidate.order.reservationId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${candidate.id} FOR UPDATE`;
        const attempt = await tx.paymentAttempt.findUnique({
          where: { id: candidate.id },
          include: { order: { include: { reservation: true } } },
        });
        if (!attempt) conflict();
        const decision = decideAuthoritativePaymentReconciliation(
          {
            payment: {
              providerPaymentId: attempt.providerPaymentId,
              amountMinor: attempt.amountMinor,
              currencyCode: attempt.currencyCode,
              status: attempt.status,
            },
            paymentFailureCode: attempt.failureCode,
            reservationStatus: attempt.order.reservation.status,
          },
          {
            providerPaymentId: providerResult.paymentId,
            amountMinor: candidate.amountMinor,
            currencyCode: candidate.currencyCode,
            status: evidenceStatus,
          },
        );

        if (decision.outcome === 'COMPLETE_NO_OP') return { outcome: 'NO_OP' } as const;
        if (decision.outcome === 'RETAIN_FOR_REVIEW') return { outcome: 'RETAINED' } as const;
        if (decision.outcome === 'REJECT_EVIDENCE') return { outcome: 'REJECTED' } as const;
        if (decision.outcome === 'LATE_SUCCESS_RECOVERY') {
          return this.recoverLateSuccess(tx, attempt.id, requestId);
        }
        if (decision.nextStatus === PaymentAttemptStatus.PROCESSING) {
          const changed = await tx.paymentAttempt.updateMany({
            where: { id: attempt.id, status: PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD },
            data: { status: PaymentAttemptStatus.PROCESSING },
          });
          if (changed.count !== 1) conflict();
          return { outcome: 'APPLIED' } as const;
        }
        await this.outcomes.applyInTransaction(tx, {
          orderId: attempt.orderId,
          paymentAttemptId: attempt.id,
          status: decision.nextStatus === PaymentAttemptStatus.SUCCEEDED ? 'succeeded' : 'failed',
          providerPaymentId: providerResult.paymentId,
          requestId,
          allowAuthoritativeSkippedSuccess: true,
          ...(decision.nextStatus === PaymentAttemptStatus.FAILED
            ? { failureCode: 'PAYMENT_DECLINED' }
            : {}),
        });
        return { outcome: 'APPLIED' } as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async recoverLateSuccess(
    tx: Prisma.TransactionClient,
    paymentAttemptId: string,
    requestId: string,
  ): Promise<PaymentReconciliationExecutionResult> {
    const attempt = await tx.paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
      include: {
        order: {
          include: {
            cart: true,
            lines: true,
            reservation: { include: { items: true } },
            fulfillmentGroups: true,
            paymentCompensations: true,
          },
        },
      },
    });
    if (
      !attempt ||
      attempt.status !== PaymentAttemptStatus.FAILED ||
      attempt.failureCode !== 'RESERVATION_EXPIRED' ||
      attempt.order.status !== OrderStatus.PENDING_PAYMENT ||
      attempt.order.reservation.status !== ReservationStatus.EXPIRED ||
      attempt.order.recoveryReservationId !== null ||
      attempt.order.fulfillmentGroups.length !== 0 ||
      attempt.order.paymentCompensations.length !== 0 ||
      attempt.order.cart.status !== CartStatus.OPEN
    ) {
      conflict();
    }
    const items = [...attempt.order.reservation.items].sort(
      (left, right) =>
        left.variantId.localeCompare(right.variantId) ||
        left.warehouseId.localeCompare(right.warehouseId),
    );
    if (items.length === 0) conflict();
    const variantIds = [...new Set(items.map((item) => item.variantId))];
    const warehouseIds = [...new Set(items.map((item) => item.warehouseId))];
    await tx.$queryRaw`
      SELECT "id" FROM "InventoryBalance"
      WHERE "variantId" IN (${Prisma.join(variantIds)})
        AND "warehouseId" IN (${Prisma.join(warehouseIds)})
      ORDER BY "variantId", "warehouseId", "id" FOR UPDATE
    `;
    const balances = await tx.inventoryBalance.findMany({
      where: { variantId: { in: variantIds }, warehouseId: { in: warehouseIds } },
    });
    const byKey = new Map(
      balances.map((balance) => [`${balance.warehouseId}:${balance.variantId}`, balance]),
    );
    const hasStock = items.every((item) => {
      const balance = byKey.get(`${item.warehouseId}:${item.variantId}`);
      return (
        !!balance &&
        balance.onHand - balance.reserved - balance.allocated - balance.damaged >= item.quantity
      );
    });

    const paymentChanged = await tx.paymentAttempt.updateMany({
      where: {
        id: attempt.id,
        status: PaymentAttemptStatus.FAILED,
        failureCode: 'RESERVATION_EXPIRED',
      },
      data: { status: PaymentAttemptStatus.SUCCEEDED, failureCode: null },
    });
    if (paymentChanged.count !== 1) conflict();

    if (!hasStock) {
      await tx.order.update({
        where: { id: attempt.order.id },
        data: { status: OrderStatus.MANUAL_RESOLUTION },
      });
      const compensation = await tx.paymentCompensation.create({
        data: {
          orderId: attempt.order.id,
          paymentAttemptId: attempt.id,
          reason: PaymentCompensationReason.LATE_SUCCESS_STOCK_UNAVAILABLE,
          provider: attempt.provider,
          amountMinor: attempt.amountMinor,
          currencyCode: attempt.currencyCode,
        },
      });
      await this.recordOutcome(tx, attempt.order.id, requestId, 'compensation_required');
      return { outcome: 'COMPENSATION_REQUIRED', compensationId: compensation.id };
    }

    const recovery = await tx.inventoryReservation.create({ data: { expiresAt: new Date() } });
    for (const [sequence, item] of items.entries()) {
      const balance = byKey.get(`${item.warehouseId}:${item.variantId}`)!;
      const reserved = await tx.inventoryBalance.update({
        where: { id: balance.id },
        data: { reserved: { increment: item.quantity }, version: { increment: 1 } },
      });
      await tx.inventoryReservationItem.create({
        data: {
          reservationId: recovery.id,
          warehouseId: item.warehouseId,
          variantId: item.variantId,
          quantity: item.quantity,
        },
      });
      await tx.inventoryMovement.create({
        data: {
          warehouseId: item.warehouseId,
          variantId: item.variantId,
          type: InventoryMovementType.RESERVED,
          reservedDelta: item.quantity,
          resultingOnHand: reserved.onHand,
          resultingReserved: reserved.reserved,
          resultingAllocated: reserved.allocated,
          resultingDamaged: reserved.damaged,
          commandId: recovery.id,
          commandSequence: sequence + 1,
          actorType: AuditActorType.SYSTEM,
          actorId: 'payment-reconciliation',
          reason: 'late-payment-re-reservation',
        },
      });
    }
    for (const [sequence, item] of items.entries()) {
      const balance = byKey.get(`${item.warehouseId}:${item.variantId}`)!;
      const committed = await tx.inventoryBalance.update({
        where: { id: balance.id },
        data: {
          reserved: { decrement: item.quantity },
          allocated: { increment: item.quantity },
          version: { increment: 1 },
        },
      });
      await tx.inventoryMovement.create({
        data: {
          warehouseId: item.warehouseId,
          variantId: item.variantId,
          type: InventoryMovementType.RESERVATION_COMMITTED,
          reservedDelta: -item.quantity,
          allocatedDelta: item.quantity,
          resultingOnHand: committed.onHand,
          resultingReserved: committed.reserved,
          resultingAllocated: committed.allocated,
          resultingDamaged: committed.damaged,
          commandId: recovery.id,
          commandSequence: 1000 + sequence,
          actorType: AuditActorType.SYSTEM,
          actorId: 'payment-reconciliation',
          reason: 'late-payment-committed',
        },
      });
    }
    await tx.inventoryReservation.update({
      where: { id: recovery.id },
      data: { status: ReservationStatus.COMMITTED },
    });
    await tx.order.update({
      where: { id: attempt.order.id },
      data: { status: OrderStatus.CONFIRMED, recoveryReservationId: recovery.id },
    });
    for (const warehouseId of warehouseIds) {
      const group = await tx.fulfillmentGroup.create({
        data: { orderId: attempt.order.id, warehouseId },
      });
      const warehouseItems = items.filter((item) => item.warehouseId === warehouseId);
      await tx.fulfillmentGroupItem.createMany({
        data: warehouseItems.map((item) => ({
          fulfillmentGroupId: group.id,
          orderLineId: attempt.order.lines.find((line) => line.variantId === item.variantId)!.id,
          quantity: item.quantity,
        })),
      });
    }
    await tx.cartItem.deleteMany({ where: { cartId: attempt.order.cartId } });
    await tx.cart.update({
      where: { id: attempt.order.cartId },
      data: { status: CartStatus.CONVERTED, revision: { increment: 1 } },
    });
    await this.recordOutcome(tx, attempt.order.id, requestId, 'late_success_confirmed');
    return { outcome: 'LATE_SUCCESS_CONFIRMED', recoveryReservationId: recovery.id };
  }

  private async recordOutcome(
    tx: Prisma.TransactionClient,
    orderId: string,
    requestId: string,
    outcome: 'late_success_confirmed' | 'compensation_required',
  ): Promise<void> {
    await this.audit.append(
      tx,
      {
        action:
          outcome === 'late_success_confirmed'
            ? 'commerce.order.late-payment-confirmed'
            : 'commerce.payment.compensation-required',
        targetType: 'order',
        targetId: orderId,
        afterMetadata: { outcome },
      },
      {
        idempotencyKey: `payment-reconciliation-${orderId}`,
        requestId,
        correlationId: requestId,
        actor: { type: 'system', id: 'payment-reconciliation', roles: [] },
        reason: 'Apply authoritative late payment evidence.',
      },
    );
    await tx.outboxMessage.create({
      data: {
        eventType:
          outcome === 'late_success_confirmed'
            ? 'commerce.order.late-payment-confirmed'
            : 'commerce.payment.compensation-required',
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: orderId,
        payload: { orderId, outcome },
        correlationId: requestId,
      },
    });
  }
}
