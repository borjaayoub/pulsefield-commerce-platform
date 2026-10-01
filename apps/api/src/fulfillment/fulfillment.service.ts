import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuditedCommandContext } from '../audit/command-context';
import { normalizeAuditedCommandContext } from '../audit/command-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { Prisma, type FulfillmentGroup } from '../generated/prisma/client';
import {
  AccountStatus,
  FulfillmentGroupStatus,
  OrderStatus,
  ReservationStatus,
  PaymentAttemptStatus,
  RoleName,
} from '../generated/prisma/enums';
import { IdempotencyService, type IdempotencyClaim } from '../idempotency/idempotency.service';
import { ForbiddenError } from '../identity/authentication.errors';
import { withCheckoutTransactionRetry } from '../checkout/checkout.service';
import { FULFILLMENT_TARGET_STATUSES } from './fulfillment.dto';
import { FulfillmentConflictError, FulfillmentRequestError } from './fulfillment.errors';
import {
  appendRealtimeInvalidation,
  FULFILLMENT_INVALIDATED_EVENT,
  INVENTORY_INVALIDATED_EVENT,
} from '../realtime/realtime.events';

const CARRIER_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/u;
const TRACKING_PATTERN = /^[A-Z0-9][A-Z0-9._-]{5,63}$/u;
const REASON_PATTERN = /^[\x20-\x7E]{1,500}$/u;
const REASON_EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;
const REASON_PHONE_PATTERN = /(?:\+?\d[\d .()_-]{8,}\d)/u;
const DEMO_CARRIER_CODES = new Set(['DHL', 'FEDEX', 'UPS', 'USPS']);

const FULFILLMENT_INCLUDE = {
  items: {
    orderBy: [{ orderLineId: 'asc' as const }, { id: 'asc' as const }],
    include: { orderLine: true },
  },
  order: {
    select: {
      id: true,
      status: true,
      reservation: { include: { items: true } },
      recoveryReservation: { include: { items: true } },
      paymentAttempts: {
        where: { status: PaymentAttemptStatus.SUCCEEDED },
        orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
        take: 1,
      },
      lines: true,
    },
  },
} satisfies Prisma.FulfillmentGroupInclude;

type FulfillmentRecord = Prisma.FulfillmentGroupGetPayload<{
  include: typeof FULFILLMENT_INCLUDE;
}>;

type FulfillmentViewSource = Pick<
  FulfillmentGroup,
  | 'id'
  | 'orderId'
  | 'warehouseId'
  | 'status'
  | 'version'
  | 'pickingStartedAt'
  | 'packedAt'
  | 'shippedAt'
  | 'deliveredAt'
  | 'carrierCode'
  | 'trackingReference'
  | 'createdAt'
  | 'updatedAt'
>;

export interface FulfillmentTransitionInput {
  fulfillmentGroupId: string;
  expectedVersion: number | undefined;
  idempotencyKey: string | undefined;
  targetStatus: (typeof FULFILLMENT_TARGET_STATUSES)[number];
  reason: string;
  carrierCode?: string;
  trackingReference?: string;
}

export interface FulfillmentGroupView {
  id: string;
  orderId: string;
  warehouseId: string;
  status: FulfillmentGroupStatus;
  version: number;
  pickingStartedAt: string | null;
  packedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  carrierCode: string | null;
  trackingReference: string | null;
  createdAt: string;
  updatedAt: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function auditContext(command: AuditedCommandContext): AuditedCommandContext {
  return { ...command, idempotencyKey: `fulfillment-${digest(command.idempotencyKey)}` };
}

function normalizeAscii(value: string | undefined, pattern: RegExp): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!pattern.test(normalized)) throw new FulfillmentRequestError();
  return normalized;
}

function normalizeTransition(input: FulfillmentTransitionInput): {
  targetStatus: (typeof FULFILLMENT_TARGET_STATUSES)[number];
  reason: string;
  carrierCode?: string;
  trackingReference?: string;
} {
  if (!FULFILLMENT_TARGET_STATUSES.includes(input.targetStatus)) {
    throw new FulfillmentRequestError();
  }
  const reason = input.reason.trim();
  if (
    reason.length < 1 ||
    reason.length > 500 ||
    !REASON_PATTERN.test(reason) ||
    REASON_EMAIL_PATTERN.test(reason) ||
    REASON_PHONE_PATTERN.test(reason)
  ) {
    throw new FulfillmentRequestError();
  }

  const carrierCode = normalizeAscii(input.carrierCode, CARRIER_PATTERN);
  const trackingReference = normalizeAscii(input.trackingReference, TRACKING_PATTERN);
  if (input.targetStatus === FulfillmentGroupStatus.SHIPPED) {
    if (!carrierCode || !DEMO_CARRIER_CODES.has(carrierCode) || !trackingReference) {
      throw new FulfillmentRequestError();
    }
  } else if (carrierCode !== undefined || trackingReference !== undefined) {
    throw new FulfillmentRequestError();
  }

  return { targetStatus: input.targetStatus, reason, carrierCode, trackingReference };
}

function transitionAllowed(
  current: FulfillmentGroupStatus,
  target: FulfillmentGroupStatus,
): boolean {
  return (
    (current === FulfillmentGroupStatus.ALLOCATED && target === FulfillmentGroupStatus.PICKING) ||
    (current === FulfillmentGroupStatus.PICKING && target === FulfillmentGroupStatus.PACKED) ||
    (current === FulfillmentGroupStatus.PACKED && target === FulfillmentGroupStatus.SHIPPED) ||
    (current === FulfillmentGroupStatus.SHIPPED && target === FulfillmentGroupStatus.DELIVERED)
  );
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function toView(group: FulfillmentViewSource): FulfillmentGroupView {
  return {
    id: group.id,
    orderId: group.orderId,
    warehouseId: group.warehouseId,
    status: group.status,
    version: group.version,
    pickingStartedAt: iso(group.pickingStartedAt),
    packedAt: iso(group.packedAt),
    shippedAt: iso(group.shippedAt),
    deliveredAt: iso(group.deliveredAt),
    carrierCode: group.carrierCode,
    trackingReference: group.trackingReference,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  async transition(
    input: FulfillmentTransitionInput,
    context: AuditedCommandContext,
  ): Promise<FulfillmentGroupView> {
    const command = normalizeAuditedCommandContext(context);
    if (!command.actor.roles.includes(RoleName.FULFILLER)) throw new ForbiddenError();
    if (!input.idempotencyKey) {
      throw new FulfillmentConflictError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'An idempotency key is required for fulfillment transitions.',
      );
    }
    if (input.expectedVersion === undefined) {
      throw new FulfillmentConflictError(
        'FULFILLMENT_REVISION_REQUIRED',
        'The fulfillment revision is required for this transition.',
      );
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new FulfillmentRequestError();
    }
    const normalized = normalizeTransition(input);
    const claimResult = await this.idempotency.begin(
      {
        operation: 'fulfillment.transition',
        request: {
          fulfillmentGroupId: input.fulfillmentGroupId,
          expectedVersion: input.expectedVersion,
          targetStatus: normalized.targetStatus,
          reason: normalized.reason,
          ...(normalized.carrierCode !== undefined ? { carrierCode: normalized.carrierCode } : {}),
          ...(normalized.trackingReference !== undefined
            ? { trackingReference: normalized.trackingReference }
            : {}),
        },
      },
      command,
    );
    if (claimResult.kind === 'replay') return this.responseForResult(claimResult.result.id);
    if (claimResult.kind === 'in-progress') {
      throw new FulfillmentConflictError(
        'FULFILLMENT_UNAVAILABLE',
        'The fulfillment transition is already in progress. Retry shortly.',
      );
    }

    try {
      return await withCheckoutTransactionRetry(() =>
        this.applyTransition(
          input.fulfillmentGroupId,
          input.expectedVersion!,
          normalized,
          claimResult.claim,
          command,
        ),
      );
    } catch (error) {
      await this.idempotency
        .fail(
          claimResult.claim,
          error instanceof FulfillmentConflictError ? error.code : 'FULFILLMENT_RETRYABLE',
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async responseForResult(resultId: string): Promise<FulfillmentGroupView> {
    const result = await this.prisma.fulfillmentTransitionResult.findUnique({
      where: { id: resultId },
      include: { fulfillmentGroup: { select: { id: true } } },
    });
    if (!result || !result.fulfillmentGroup)
      throw new FulfillmentConflictError(
        'FULFILLMENT_NOT_FOUND',
        'Fulfillment group was not found.',
      );
    return toView({ ...result, id: result.fulfillmentGroupId });
  }

  private async applyTransition(
    groupId: string,
    expectedVersion: number,
    input: {
      targetStatus: (typeof FULFILLMENT_TARGET_STATUSES)[number];
      reason: string;
      carrierCode?: string;
      trackingReference?: string;
    },
    claim: IdempotencyClaim,
    command: AuditedCommandContext,
  ): Promise<FulfillmentGroupView> {
    return this.prisma.$transaction(
      async (tx) => {
        const identity = await tx.fulfillmentGroup.findUnique({
          where: { id: groupId },
          select: { orderId: true },
        });
        if (!identity) {
          throw new FulfillmentConflictError(
            'FULFILLMENT_NOT_FOUND',
            'Fulfillment group was not found.',
          );
        }

        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${command.actor.id} FOR UPDATE`;
        const actor = await tx.user.findUnique({
          where: { id: command.actor.id },
          select: { status: true, verifiedAt: true, userRoles: { select: { role: true } } },
        });
        if (
          !actor ||
          actor.status !== AccountStatus.ACTIVE ||
          !actor.verifiedAt ||
          !actor.userRoles.some(({ role }) => role === RoleName.FULFILLER)
        ) {
          throw new ForbiddenError();
        }

        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${identity.orderId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "FulfillmentGroup" WHERE "id" = ${groupId} FOR UPDATE`;
        const group = await tx.fulfillmentGroup.findUnique({
          where: { id: groupId },
          include: FULFILLMENT_INCLUDE,
        });
        if (!group) {
          throw new FulfillmentConflictError(
            'FULFILLMENT_NOT_FOUND',
            'Fulfillment group was not found.',
          );
        }
        if (group.version !== expectedVersion) {
          throw new FulfillmentConflictError(
            'FULFILLMENT_REVISION_CONFLICT',
            'The fulfillment group changed since it was last read. Refresh and try again.',
            group.version,
          );
        }
        if (!transitionAllowed(group.status, input.targetStatus)) {
          throw new FulfillmentConflictError(
            'FULFILLMENT_TRANSITION_INVALID',
            'The fulfillment group cannot make that transition.',
            group.version,
          );
        }

        const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`
          SELECT CURRENT_TIMESTAMP AS "now"
        `;
        if (input.targetStatus === FulfillmentGroupStatus.SHIPPED) {
          await this.decrementAllocatedStock(tx, group, command.actor.id);
        }

        const updated = await tx.fulfillmentGroup.update({
          where: { id: group.id },
          data: {
            status: input.targetStatus,
            version: { increment: 1 },
            ...(input.targetStatus === FulfillmentGroupStatus.PICKING
              ? { pickingStartedAt: now }
              : {}),
            ...(input.targetStatus === FulfillmentGroupStatus.PACKED ? { packedAt: now } : {}),
            ...(input.targetStatus === FulfillmentGroupStatus.SHIPPED
              ? {
                  shippedAt: now,
                  carrierCode: input.carrierCode,
                  trackingReference: input.trackingReference,
                }
              : {}),
            ...(input.targetStatus === FulfillmentGroupStatus.DELIVERED
              ? { deliveredAt: now }
              : {}),
          },
        });

        const result = await tx.fulfillmentTransitionResult.create({
          data: {
            id: randomUUID(),
            idempotencyRecordId: claim.recordId,
            fulfillmentGroupId: updated.id,
            orderId: updated.orderId,
            warehouseId: updated.warehouseId,
            status: updated.status,
            version: updated.version,
            pickingStartedAt: updated.pickingStartedAt,
            packedAt: updated.packedAt,
            shippedAt: updated.shippedAt,
            deliveredAt: updated.deliveredAt,
            carrierCode: updated.carrierCode,
            trackingReference: updated.trackingReference,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
          },
        });

        const nextVersion = group.version + 1;
        const commandForAudit = auditContext(command);
        await this.audit.append(
          tx,
          {
            action: 'commerce.fulfillment.transitioned',
            targetType: 'fulfillment-group',
            targetId: group.id,
            beforeMetadata: { status: group.status, version: group.version },
            afterMetadata: { status: updated.status, version: nextVersion },
          },
          { ...commandForAudit, reason: input.reason },
        );
        await tx.outboxMessage.create({
          data: {
            id: randomUUID(),
            eventType: `commerce.fulfillment.${input.targetStatus.toLowerCase()}`,
            eventVersion: 1,
            aggregateType: 'fulfillment-group',
            aggregateId: group.id,
            payload: {
              fulfillmentGroupId: group.id,
              orderId: group.orderId,
              status: updated.status,
              version: nextVersion,
            },
            correlationId: command.correlationId,
            causationId: command.requestId,
          },
        });
        await appendRealtimeInvalidation(tx, {
          type: FULFILLMENT_INVALIDATED_EVENT,
          aggregateType: 'fulfillment-group',
          resourceId: group.id,
          resourceVersion: nextVersion,
          correlationId: command.correlationId,
          causationId: command.requestId,
        });
        if (input.targetStatus === FulfillmentGroupStatus.SHIPPED) {
          const balances = await tx.inventoryBalance.findMany({
            where: {
              warehouseId: group.warehouseId,
              variantId: { in: group.items.map((item) => item.orderLine.variantId) },
            },
            select: { id: true, version: true },
          });
          for (const balance of balances) {
            await appendRealtimeInvalidation(tx, {
              type: INVENTORY_INVALIDATED_EVENT,
              aggregateType: 'inventory-balance',
              resourceId: balance.id,
              resourceVersion: balance.version,
              correlationId: command.correlationId,
              causationId: command.requestId,
            });
          }
        }
        await this.idempotency.complete(tx, claim, {
          type: 'fulfillment-transition',
          id: result.id,
          responseStatus: 200,
        });
        return toView(updated);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async decrementAllocatedStock(
    tx: Prisma.TransactionClient,
    group: FulfillmentRecord,
    actorId: string,
  ): Promise<void> {
    if (
      group.order.status !== OrderStatus.CONFIRMED ||
      (group.order.recoveryReservation ?? group.order.reservation).status !==
        ReservationStatus.COMMITTED ||
      group.order.paymentAttempts.length !== 1
    ) {
      throw new FulfillmentConflictError(
        'FULFILLMENT_TRANSITION_INVALID',
        'Only a confirmed order with a committed reservation can ship.',
        group.version,
      );
    }
    const reservation = group.order.recoveryReservation ?? group.order.reservation;
    const expectedItems = reservation.items.filter(
      (item) => item.warehouseId === group.warehouseId,
    );
    if (
      group.items.length !== expectedItems.length ||
      group.items.some(
        (item) =>
          item.orderLine.orderId !== group.order.id ||
          !expectedItems.some(
            (reservationItem) =>
              reservationItem.variantId === item.orderLine.variantId &&
              reservationItem.quantity === item.quantity,
          ),
      ) ||
      expectedItems.some(
        (reservationItem) =>
          !group.items.some(
            (item) =>
              item.orderLine.variantId === reservationItem.variantId &&
              item.quantity === reservationItem.quantity,
          ),
      )
    ) {
      throw new FulfillmentConflictError(
        'FULFILLMENT_TRANSITION_INVALID',
        'Fulfillment quantities are not fully allocated.',
        group.version,
      );
    }

    const variantIds = [...new Set(group.items.map((item) => item.orderLine.variantId))].sort();
    await tx.$queryRaw`
      SELECT "id"
      FROM "InventoryBalance"
      WHERE "warehouseId" = ${group.warehouseId}
        AND "variantId" IN (${Prisma.join(variantIds)})
      ORDER BY "variantId" ASC, "warehouseId" ASC, "id" ASC
      FOR UPDATE
    `;
    const balances = await tx.inventoryBalance.findMany({
      where: { warehouseId: group.warehouseId, variantId: { in: variantIds } },
      orderBy: [{ variantId: 'asc' }, { warehouseId: 'asc' }, { id: 'asc' }],
    });
    const balanceByVariant = new Map(balances.map((balance) => [balance.variantId, balance]));
    const sortedItems = [...group.items].sort(
      (left, right) =>
        left.orderLine.variantId.localeCompare(right.orderLine.variantId) ||
        left.orderLineId.localeCompare(right.orderLineId) ||
        left.id.localeCompare(right.id),
    );
    for (const [sequence, item] of sortedItems.entries()) {
      const balance = balanceByVariant.get(item.orderLine.variantId);
      if (!balance || balance.allocated < item.quantity || balance.onHand < item.quantity) {
        throw new FulfillmentConflictError(
          'FULFILLMENT_UNAVAILABLE',
          'The allocated inventory is no longer available for shipment.',
          group.version,
        );
      }
      const updated = await tx.inventoryBalance.update({
        where: { id: balance.id },
        data: {
          onHand: { decrement: item.quantity },
          allocated: { decrement: item.quantity },
          version: { increment: 1 },
        },
      });
      await tx.inventoryMovement.create({
        data: {
          warehouseId: group.warehouseId,
          variantId: item.orderLine.variantId,
          type: 'FULFILLMENT_DECREMENT',
          onHandDelta: -item.quantity,
          allocatedDelta: -item.quantity,
          resultingOnHand: updated.onHand,
          resultingReserved: updated.reserved,
          resultingAllocated: updated.allocated,
          resultingDamaged: updated.damaged,
          commandId: group.id,
          commandSequence: sequence + 1,
          actorType: 'STAFF',
          actorId,
          reason: 'fulfillment-shipped',
        },
      });
    }
  }
}
