import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuditedCommandContext } from '../audit/command-context';
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
import { withCheckoutTransactionRetry } from '../checkout/checkout.service';
import {
  appendRealtimeInvalidation,
  INVENTORY_INVALIDATED_EVENT,
} from '../realtime/realtime.events';
import {
  ReservationExpiryConflictError,
  ReservationExpirySweepError,
} from './reservation-expiry.errors';

export const RESERVATION_EXPIRY_BATCH_SIZE = 100;

const RESERVATION_INCLUDE = {
  items: {
    orderBy: [
      { variantId: 'asc' as const },
      { warehouseId: 'asc' as const },
      { id: 'asc' as const },
    ],
  },
} satisfies Prisma.InventoryReservationInclude;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function expiryContext(reservationId: string): AuditedCommandContext {
  const key = digest(reservationId);
  return {
    requestId: `reservation-expiry-${key.slice(0, 32)}`,
    correlationId: `reservation-expiry-${key.slice(0, 32)}`,
    idempotencyKey: `reservation-expiry-${key}`,
    actor: { type: 'system', id: 'reservation-expiry-scheduler', roles: ['RESERVATION_EXPIRY'] },
    reason: 'Expire an overdue inventory reservation.',
  };
}

@Injectable()
export class ReservationExpiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async sweepExpired(limit = RESERVATION_EXPIRY_BATCH_SIZE): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RESERVATION_EXPIRY_BATCH_SIZE) {
      throw new ReservationExpiryConflictError();
    }
    const candidates = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "InventoryReservation"
      WHERE "status" = 'ACTIVE'
        AND "expiresAt" <= CURRENT_TIMESTAMP
      ORDER BY "expiresAt" ASC, "id" ASC
      LIMIT ${limit}
    `;
    let expired = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        if (await withCheckoutTransactionRetry(() => this.expireOne(candidate.id))) expired += 1;
      } catch {
        // A failed candidate remains eligible for the next bounded sweep. The
        // scheduler must not prevent unrelated reservations from being tried.
        failed += 1;
      }
    }
    if (failed > 0) throw new ReservationExpirySweepError(expired, failed);
    return expired;
  }

  private async expireOne(reservationId: string): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const orderIdentity = await tx.order.findUnique({
          where: { reservationId },
          select: { id: true, cartId: true },
        });
        if (orderIdentity) {
          await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderIdentity.id} FOR UPDATE`;
        }
        await tx.$queryRaw`
          SELECT "id"
          FROM "InventoryReservation"
          WHERE "id" = ${reservationId}
          FOR UPDATE
        `;
        if (orderIdentity) {
          await tx.$queryRaw`
            SELECT "id"
            FROM "PaymentAttempt"
            WHERE "orderId" = ${orderIdentity.id}
            ORDER BY "createdAt" ASC, "id" ASC
            FOR UPDATE
          `;
        }

        const reservation = await tx.inventoryReservation.findUnique({
          where: { id: reservationId },
          include: RESERVATION_INCLUDE,
        });
        if (!reservation || reservation.status !== ReservationStatus.ACTIVE) return false;
        const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`
          SELECT CURRENT_TIMESTAMP AS "now"
        `;
        if (reservation.expiresAt > now) return false;
        if (reservation.items.length === 0) throw new ReservationExpiryConflictError();

        const order = orderIdentity
          ? await tx.order.findUnique({
              where: { id: orderIdentity.id },
              select: { id: true, cartId: true, status: true },
            })
          : null;
        if (!order || order.status !== OrderStatus.PENDING_PAYMENT) {
          throw new ReservationExpiryConflictError();
        }
        const activePayments = await tx.paymentAttempt.findMany({
          where: {
            orderId: order.id,
            status: {
              in: [PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD, PaymentAttemptStatus.PROCESSING],
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (activePayments.length !== 1) {
          throw new ReservationExpiryConflictError();
        }
        const payment = activePayments[0]!;

        const variantIds = [...new Set(reservation.items.map((item) => item.variantId))].sort();
        const warehouseIds = [...new Set(reservation.items.map((item) => item.warehouseId))].sort();
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
        for (const [sequence, item] of reservation.items.entries()) {
          const balance = balanceByKey.get(`${item.warehouseId}:${item.variantId}`);
          if (!balance || balance.reserved < item.quantity) {
            throw new ReservationExpiryConflictError();
          }
          const updated = await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: { reserved: { decrement: item.quantity }, version: { increment: 1 } },
          });
          await tx.inventoryMovement.create({
            data: {
              warehouseId: item.warehouseId,
              variantId: item.variantId,
              type: InventoryMovementType.RESERVATION_EXPIRED,
              reservedDelta: -item.quantity,
              resultingOnHand: updated.onHand,
              resultingReserved: updated.reserved,
              resultingAllocated: updated.allocated,
              resultingDamaged: updated.damaged,
              commandId: reservation.id,
              commandSequence: 2000 + sequence,
              actorType: AuditActorType.SYSTEM,
              actorId: 'reservation-expiry-scheduler',
              reason: 'reservation-expired',
            },
          });
          await appendRealtimeInvalidation(tx, {
            type: INVENTORY_INVALIDATED_EVENT,
            aggregateType: 'inventory-balance',
            resourceId: updated.id,
            resourceVersion: updated.version,
            correlationId: reservation.id,
          });
        }

        const reservationChanged = await tx.inventoryReservation.updateMany({
          where: { id: reservation.id, status: ReservationStatus.ACTIVE },
          data: { status: ReservationStatus.EXPIRED },
        });
        if (reservationChanged.count !== 1) throw new ReservationExpiryConflictError();

        const expiryPaymentId = `expiry-${reservation.id}`;
        const needsStubExpiryIdentity =
          payment.provider === 'stub' && payment.providerPaymentId === null;
        const paymentChanged = await tx.paymentAttempt.updateMany({
          where: { id: payment.id, status: payment.status },
          data: {
            status: PaymentAttemptStatus.FAILED,
            ...(needsStubExpiryIdentity
              ? {
                  providerPaymentId: expiryPaymentId,
                  providerReference: expiryPaymentId,
                }
              : {}),
            failureCode: 'RESERVATION_EXPIRED',
          },
        });
        if (paymentChanged.count !== 1) throw new ReservationExpiryConflictError();

        const cart = await tx.cart.findUnique({
          where: { id: order.cartId },
          select: { id: true, status: true },
        });
        if (!cart || cart.status !== CartStatus.CHECKOUT_PENDING) {
          throw new ReservationExpiryConflictError();
        }
        await tx.cart.update({
          where: { id: cart.id },
          data: { status: CartStatus.OPEN, revision: { increment: 1 } },
        });

        const context = expiryContext(reservation.id);
        await this.audit.append(
          tx,
          {
            action: 'commerce.reservation.expired',
            targetType: 'reservation',
            targetId: reservation.id,
            afterMetadata: { orderId: order.id, outcome: 'expired' },
          },
          context,
        );
        await tx.outboxMessage.create({
          data: {
            eventType: 'commerce.reservation.expired',
            eventVersion: 1,
            aggregateType: 'reservation',
            aggregateId: reservation.id,
            payload: { reservationId: reservation.id, orderId: order.id, outcome: 'expired' },
            correlationId: context.correlationId,
          },
        });
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
