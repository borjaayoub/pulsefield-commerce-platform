import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  AuditActorType,
  CartStatus,
  InventoryMovementType,
  OrderStatus,
  PaymentAttemptStatus,
  ReservationStatus,
} from '../generated/prisma/enums';

export class PaymentOutcomeConflictError extends Error {
  readonly code = 'PAYMENT_OUTCOME_CONFLICT';

  constructor() {
    super('The payment outcome could not be applied safely.');
  }
}

export interface PaymentOutcomeInput {
  orderId: string;
  paymentAttemptId: string;
  status: 'succeeded' | 'failed';
  providerPaymentId?: string;
  requestId: string;
  failureCode?: string;
  rejectExpiredSuccess?: boolean;
  allowAuthoritativeSkippedSuccess?: boolean;
}

function digestKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function conflict(): never {
  throw new PaymentOutcomeConflictError();
}

@Injectable()
export class PaymentOutcomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async apply(input: PaymentOutcomeInput): Promise<void> {
    await this.prisma.$transaction((tx) => this.applyInTransaction(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  async applyInTransaction(
    tx: Prisma.TransactionClient,
    input: PaymentOutcomeInput,
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE`;
    const lockedOrder = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { reservationId: true },
    });
    if (!lockedOrder) conflict();
    await tx.$queryRaw`SELECT "id" FROM "InventoryReservation" WHERE "id" = ${lockedOrder.reservationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${input.paymentAttemptId} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: {
        lines: true,
        reservation: { include: { items: true } },
        paymentAttempts: { where: { id: input.paymentAttemptId }, take: 1 },
        fulfillmentGroups: { include: { items: true } },
      },
    });
    const attempt = order?.paymentAttempts[0];
    if (!order || !attempt || attempt.orderId !== input.orderId) conflict();

    const reservationItems = [...order.reservation.items].sort(
      (left, right) =>
        left.variantId.localeCompare(right.variantId) ||
        left.warehouseId.localeCompare(right.warehouseId),
    );
    const variantIds = [...new Set(reservationItems.map((item) => item.variantId))];
    const warehouseIds = [...new Set(reservationItems.map((item) => item.warehouseId))];
    if (variantIds.length === 0 || warehouseIds.length === 0) conflict();
    await tx.$queryRaw`
      SELECT "id"
      FROM "InventoryBalance"
      WHERE "variantId" IN (${Prisma.join(variantIds)})
        AND "warehouseId" IN (${Prisma.join(warehouseIds)})
      ORDER BY "variantId" ASC, "warehouseId" ASC, "id" ASC
      FOR UPDATE
    `;
    const balances = await tx.inventoryBalance.findMany({
      where: { variantId: { in: variantIds }, warehouseId: { in: warehouseIds } },
      orderBy: [{ variantId: 'asc' }, { warehouseId: 'asc' }, { id: 'asc' }],
    });
    const balanceByKey = new Map(
      balances.map((balance) => [`${balance.warehouseId}:${balance.variantId}`, balance]),
    );
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
    const mayApplyTerminal =
      attempt.status === PaymentAttemptStatus.PROCESSING ||
      (attempt.status === PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD &&
        input.status === 'succeeded' &&
        input.allowAuthoritativeSkippedSuccess) ||
      (attempt.status === PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD &&
        input.status === 'failed');

    if (!mayApplyTerminal) {
      const sameOutcome =
        (input.status === 'succeeded' && attempt.status === PaymentAttemptStatus.SUCCEEDED) ||
        (input.status === 'failed' && attempt.status === PaymentAttemptStatus.FAILED);
      if (!sameOutcome || attempt.providerPaymentId !== (input.providerPaymentId ?? null))
        conflict();
      const committed = attempt.status === PaymentAttemptStatus.SUCCEEDED;
      const expiredFailure =
        !committed &&
        attempt.failureCode === 'RESERVATION_EXPIRED' &&
        order.reservation.status === ReservationStatus.EXPIRED;
      const movementType = committed
        ? InventoryMovementType.RESERVATION_COMMITTED
        : expiredFailure
          ? InventoryMovementType.RESERVATION_EXPIRED
          : InventoryMovementType.RESERVATION_RELEASED;
      const movementCount = await tx.inventoryMovement.count({
        where: { commandId: order.reservationId, type: movementType },
      });
      const expectedWarehouseIds = new Set(reservationItems.map((item) => item.warehouseId));
      const hasExpectedFulfillment = committed
        ? order.fulfillmentGroups.length === expectedWarehouseIds.size &&
          order.fulfillmentGroups.every(
            (group) => group.status === 'ALLOCATED' && expectedWarehouseIds.has(group.warehouseId),
          ) &&
          order.fulfillmentGroups.reduce((total, group) => total + group.items.length, 0) ===
            reservationItems.length &&
          reservationItems.every((reservationItem) => {
            const line = order.lines.find(
              (candidate) => candidate.variantId === reservationItem.variantId,
            );
            const group = order.fulfillmentGroups.find(
              (candidate) => candidate.warehouseId === reservationItem.warehouseId,
            );
            return group?.items.some(
              (item) => item.orderLineId === line?.id && item.quantity === reservationItem.quantity,
            );
          }) &&
          order.lines.every(
            (line) =>
              order.fulfillmentGroups.reduce(
                (quantity, group) =>
                  quantity +
                  (group.items.find((item) => item.orderLineId === line.id)?.quantity ?? 0),
                0,
              ) === line.quantity,
          )
        : order.fulfillmentGroups.length === 0;
      const cart = await tx.cart.findUnique({
        where: { id: order.cartId },
        include: { items: true },
      });
      if (!cart) conflict();
      const failedStateComplete =
        order.status === OrderStatus.PENDING_PAYMENT &&
        order.reservation.status ===
          (expiredFailure ? ReservationStatus.EXPIRED : ReservationStatus.RELEASED) &&
        cart.status === CartStatus.OPEN &&
        hasExpectedFulfillment &&
        ((expiredFailure && attempt.failureCode === 'RESERVATION_EXPIRED') ||
          (!expiredFailure && attempt.failureCode !== 'RESERVATION_EXPIRED'));
      const terminalStateComplete =
        movementCount === reservationItems.length &&
        ((committed &&
          order.status === OrderStatus.CONFIRMED &&
          order.reservation.status === ReservationStatus.COMMITTED &&
          hasExpectedFulfillment) ||
          (!committed && failedStateComplete));
      if (
        !terminalStateComplete ||
        (committed && (cart.status !== CartStatus.CONVERTED || cart.items.length !== 0)) ||
        (!committed && cart.status !== CartStatus.OPEN)
      ) {
        conflict();
      }
      return;
    }

    const expired = order.reservation.expiresAt <= now;
    if (input.status === 'succeeded' && expired && input.rejectExpiredSuccess) conflict();
    const succeeded = input.status === 'succeeded' && !expired;
    const failedReservationStatus = expired
      ? ReservationStatus.EXPIRED
      : ReservationStatus.RELEASED;
    const failedMovementType = expired
      ? InventoryMovementType.RESERVATION_EXPIRED
      : InventoryMovementType.RESERVATION_RELEASED;
    const failedMovementSequenceBase = expired ? 2000 : 1000;
    const reservationChanged = await tx.inventoryReservation.updateMany({
      where: { id: order.reservationId, status: ReservationStatus.ACTIVE },
      data: { status: succeeded ? ReservationStatus.COMMITTED : failedReservationStatus },
    });
    if (reservationChanged.count !== 1) conflict();

    for (const [sequence, item] of reservationItems.entries()) {
      const balance = balanceByKey.get(`${item.warehouseId}:${item.variantId}`);
      if (!balance || balance.reserved < item.quantity) conflict();
      const updated = await tx.inventoryBalance.update({
        where: { id: balance.id },
        data: succeeded
          ? {
              reserved: { decrement: item.quantity },
              allocated: { increment: item.quantity },
              version: { increment: 1 },
            }
          : { reserved: { decrement: item.quantity }, version: { increment: 1 } },
      });
      await tx.inventoryMovement.create({
        data: {
          warehouseId: item.warehouseId,
          variantId: item.variantId,
          type: succeeded ? InventoryMovementType.RESERVATION_COMMITTED : failedMovementType,
          reservedDelta: -item.quantity,
          allocatedDelta: succeeded ? item.quantity : 0,
          resultingOnHand: updated.onHand,
          resultingReserved: updated.reserved,
          resultingAllocated: updated.allocated,
          resultingDamaged: updated.damaged,
          commandId: order.reservationId,
          commandSequence: (succeeded ? 1000 : failedMovementSequenceBase) + sequence,
          actorType: AuditActorType.SYSTEM,
          actorId: 'payment',
          reason: succeeded ? 'payment-succeeded' : 'payment-failed',
        },
      });
    }

    const changed = await tx.paymentAttempt.updateMany({
      where: { id: attempt.id, status: attempt.status },
      data: {
        status: succeeded ? PaymentAttemptStatus.SUCCEEDED : PaymentAttemptStatus.FAILED,
        ...(input.providerPaymentId
          ? {
              providerPaymentId: input.providerPaymentId,
              providerReference: input.providerPaymentId,
            }
          : {}),
        failureCode: succeeded
          ? null
          : expired
            ? 'RESERVATION_EXPIRED'
            : (input.failureCode ?? 'PAYMENT_DECLINED'),
      },
    });
    if (changed.count !== 1) conflict();

    if (succeeded) {
      await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } });
      for (const warehouseId of warehouseIds) {
        const group = await tx.fulfillmentGroup.create({
          data: { orderId: order.id, warehouseId },
        });
        await tx.fulfillmentGroupItem.createMany({
          data: reservationItems
            .filter((item) => item.warehouseId === warehouseId)
            .map((item) => ({
              fulfillmentGroupId: group.id,
              orderLineId: order.lines.find((line) => line.variantId === item.variantId)!.id,
              quantity: item.quantity,
            })),
        });
      }
      await tx.cartItem.deleteMany({ where: { cartId: order.cartId } });
      await tx.cart.update({
        where: { id: order.cartId },
        data: { status: CartStatus.CONVERTED, revision: { increment: 1 } },
      });
    } else {
      await tx.cart.update({
        where: { id: order.cartId },
        data: { status: CartStatus.OPEN, revision: { increment: 1 } },
      });
    }

    const commandKey = digestKey({
      orderId: input.orderId,
      providerPaymentId: input.providerPaymentId,
      outcome: succeeded ? 'succeeded' : 'failed',
    }).slice(0, 64);
    await this.audit.append(
      tx,
      {
        action: succeeded ? 'commerce.order.confirmed' : 'commerce.payment.failed',
        targetType: 'order',
        targetId: order.id,
        afterMetadata: { outcome: succeeded ? 'confirmed' : 'paymentFailed' },
      },
      {
        idempotencyKey: `payment-${commandKey}`,
        requestId: input.requestId,
        correlationId: input.requestId,
        actor: { type: 'system', id: 'payment', roles: [] },
        reason: succeeded ? 'Apply verified payment success.' : 'Apply verified payment failure.',
      },
    );
    await tx.outboxMessage.create({
      data: {
        eventType: succeeded ? 'commerce.order.confirmed' : 'commerce.payment.failed',
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: {
          orderId: order.id,
          orderReference: order.reference,
          outcome: succeeded ? 'confirmed' : 'payment_failed',
        },
        correlationId: input.requestId,
      },
    });
  }
}
