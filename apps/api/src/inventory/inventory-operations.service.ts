import { ForbiddenException, Injectable, NotFoundException, HttpException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@pulse-field/contracts';
import { Prisma } from '../generated/prisma/client';
import {
  InventoryMovementType,
  InventoryTransferStatus,
  RoleName,
} from '../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { withCheckoutTransactionRetry } from '../checkout/checkout.service';
import type { IdempotencyClaim } from '../idempotency/idempotency.service';
import {
  InventoryOperationConflict,
  InventoryOperationInvalid,
} from './inventory-operations.errors';
import type {
  InventoryAdjustmentDto,
  InventoryThresholdDto,
  CreateInventoryTransferDto,
  InventoryTransferTransitionDto,
} from './inventory-operations.dto';
import { InventoryOperationsQueryDto } from './inventory-operations.dto';
import { INVENTORY_OPERATIONS_CURSOR_KEY } from './inventory-operations.constants';
import { decodeInventoryCursor, encodeInventoryCursor } from './inventory-operations.read-support';

type Writer = Prisma.TransactionClient;
type Actor = { id: string; roles: RoleName[] };
const PG_INT_MAX = 2_147_483_647;
type Command = CommandContext & { reason: string };
type LowStockRow = {
  id: string;
  warehouseId: string;
  variantId: string;
  onHand: number;
  reserved: number;
  allocated: number;
  damaged: number;
  lowStockThreshold: number;
  version: number;
};

const transferSelect = {
  id: true,
  sourceWarehouseId: true,
  destinationWarehouseId: true,
  status: true,
  version: true,
  reason: true,
  createdAt: true,
  updatedAt: true,
  dispatchedAt: true,
  receivedAt: true,
  cancelledAt: true,
  sourceWarehouse: { select: { code: true, name: true } },
  destinationWarehouse: { select: { code: true, name: true } },
  lines: {
    select: {
      variantId: true,
      quantity: true,
      received: true,
      damaged: true,
      lost: true,
      variant: { select: { sku: true, name: true } },
    },
  },
} as const;

function context(actor: Actor, idempotencyKey: string, reason: string, requestId: string): Command {
  return {
    actor: { type: 'staff', id: actor.id, roles: actor.roles },
    idempotencyKey,
    reason,
    requestId,
    correlationId: requestId,
  };
}
function ensureAdmin(actor: Actor): void {
  if (!actor.roles.includes(RoleName.ADMINISTRATOR))
    throw new ForbiddenException('Administrator role required.');
}
function versionTag(prefix: string, version: number): string {
  return `"${prefix}-${version}"`;
}
function safeReason(reason: string): string {
  const value = reason.trim();
  const control = [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
  if (
    value.length < 1 ||
    value.length > 500 ||
    control ||
    /(?:Bearer\s+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+\d[\d ()-]{7,}\d)|\b\d{3}[ ()-]\d{3}[ -]\d{4}\b)/iu.test(
      value,
    )
  )
    throw new InventoryOperationInvalid('A safe bounded reason is required.');
  return value;
}
function boundedInteger(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new InventoryOperationInvalid(`${label} is outside the supported range.`);
}
function assertPgInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < -PG_INT_MAX || value > PG_INT_MAX)
    throw new InventoryOperationConflict(
      `${label} exceeds PostgreSQL integer bounds.`,
      'INVENTORY_RANGE_CONFLICT',
    );
}
function response(
  value: Record<string, unknown>,
  resourceId: string,
  version: number,
  status: number,
  type: string,
) {
  return { ...value, id: resourceId, version, etag: versionTag(type, version) };
}

@Injectable()
export class InventoryOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    @Inject(INVENTORY_OPERATIONS_CURSOR_KEY) private readonly cursorKey: string,
  ) {}
  private serializable<T>(operation: (tx: Writer) => Promise<T>): Promise<T> {
    return withCheckoutTransactionRetry(() =>
      this.prisma.$transaction(operation, { isolationLevel: 'Serializable' }),
    );
  }
  private async assertPersistedAdmin(tx: Writer, actor: Actor): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.id} FOR UPDATE`;
    const persisted = await tx.user.findUnique({
      where: { id: actor.id },
      select: { status: true, verifiedAt: true, userRoles: { select: { role: true } } },
    });
    if (
      !persisted ||
      persisted.status !== 'ACTIVE' ||
      !persisted.verifiedAt ||
      !persisted.userRoles.some((role) => role.role === RoleName.ADMINISTRATOR)
    )
      throw new ForbiddenException('Administrator role required.');
  }

  private async claim(
    input: { operation: string; request: unknown; key?: string },
    actor: Actor,
    reason: string,
    requestId: string,
  ) {
    const key = input.key?.trim();
    if (!key) throw new InventoryOperationInvalid('Idempotency-Key is required.');
    return this.idempotency.begin(
      { operation: input.operation, request: input.request },
      context(actor, key, reason, requestId),
    );
  }
  private async replay(claim: { kind: 'replay'; result: { id: string } }) {
    const saved = await this.prisma.inventoryCommandResult.findUnique({
      where: { id: claim.result.id },
    });
    if (!saved) throw new InventoryOperationConflict('Replay result is unavailable.');
    return saved.snapshot;
  }
  private async complete(
    tx: Writer,
    claim: IdempotencyClaim,
    actor: Actor,
    reason: string,
    requestId: string,
    result: {
      type: string;
      resourceId: string;
      version: number;
      status: number;
      snapshot: object;
      transferId?: string;
      beforeMetadata?: object;
      afterMetadata?: object;
    },
  ) {
    const normalizedSnapshot = JSON.parse(JSON.stringify(result.snapshot)) as object;
    const saved = await tx.inventoryCommandResult.create({
      data: {
        id: randomUUID(),
        idempotencyRecordId: claim.recordId,
        transferId: result.transferId,
        resultType: result.type,
        resourceId: result.resourceId,
        responseStatus: result.status,
        version: result.version,
        etag: versionTag(result.transferId ? 'transfer' : 'inventory', result.version),
        snapshot: normalizedSnapshot,
      },
    });
    await this.audit.append(
      tx,
      {
        action: `inventory.${result.type}`,
        targetType: result.transferId ? 'inventory-transfer' : 'inventory-balance',
        targetId: result.resourceId,
        beforeMetadata: result.beforeMetadata ?? {},
        afterMetadata: result.afterMetadata ?? {},
      },
      context(actor, `completed-${claim.recordId}`, reason, requestId),
    );
    await this.idempotency.complete(tx, claim, {
      type: result.type,
      id: saved.id,
      responseStatus: result.status,
    });
    return normalizedSnapshot;
  }

  async adjust(
    balanceId: string,
    dto: InventoryAdjustmentDto,
    expectedVersion: number | undefined,
    actor: Actor,
    key: string | undefined,
    requestId: string,
  ) {
    ensureAdmin(actor);
    boundedInteger(dto.onHandDelta, -1_000_000, 1_000_000, 'onHandDelta');
    boundedInteger(dto.damagedDelta, -1_000_000, 1_000_000, 'damagedDelta');
    const reason = safeReason(dto.reason);
    if (expectedVersion === undefined) throw new HttpException('If-Match is required.', 428);
    if (dto.onHandDelta === 0 && dto.damagedDelta === 0)
      throw new InventoryOperationInvalid('At least one adjustment delta is required.');
    const begun = await this.claim(
      {
        operation: 'inventory.adjustment',
        request: {
          balanceId,
          onHandDelta: dto.onHandDelta,
          damagedDelta: dto.damagedDelta,
          expectedVersion,
          reason,
        },
        key,
      },
      actor,
      reason,
      requestId,
    );
    if (begun.kind === 'replay') return this.replay(begun);
    if (begun.kind !== 'acquired')
      throw new InventoryOperationConflict(
        'Another inventory command is already in progress.',
        'INVENTORY_COMMAND_IN_PROGRESS',
      );
    try {
      return await this.serializable(async (tx) => {
        await this.assertPersistedAdmin(tx, actor);
        await tx.$queryRaw`SELECT "id" FROM "InventoryBalance" WHERE "id" = ${balanceId} FOR UPDATE`;
        const before = await tx.inventoryBalance.findUnique({ where: { id: balanceId } });
        if (!before) throw new NotFoundException('Inventory balance not found.');
        if (expectedVersion === undefined || expectedVersion !== before.version)
          throw new InventoryOperationConflict(
            'The inventory balance revision is stale.',
            'INVENTORY_REVISION_CONFLICT',
            before.version,
          );
        assertPgInt(before.version + 1, 'version');
        const onHand = before.onHand + dto.onHandDelta,
          damaged = before.damaged + dto.damagedDelta;
        assertPgInt(onHand, 'onHand');
        assertPgInt(damaged, 'damaged');
        assertPgInt(before.version + 1, 'version');
        if (onHand < 0 || damaged < 0 || onHand - before.reserved - before.allocated - damaged < 0)
          throw new InventoryOperationConflict(
            'Adjustment would make stock unavailable or negative.',
          );
        const after = await tx.inventoryBalance.update({
          where: { id: balanceId },
          data: { onHand, damaged, version: { increment: 1 } },
        });
        await tx.inventoryMovement.create({
          data: {
            warehouseId: before.warehouseId,
            variantId: before.variantId,
            type: InventoryMovementType.ADJUSTMENT,
            onHandDelta: dto.onHandDelta,
            damagedDelta: dto.damagedDelta,
            resultingOnHand: onHand,
            resultingReserved: before.reserved,
            resultingAllocated: before.allocated,
            resultingDamaged: damaged,
            commandId: randomUUID(),
            actorType: 'STAFF',
            actorId: actor.id,
            reason,
          },
        });
        const body = response(
          {
            balanceId,
            onHand,
            reserved: before.reserved,
            allocated: before.allocated,
            damaged,
            available: onHand - before.reserved - before.allocated - damaged,
          },
          balanceId,
          after.version,
          200,
          'inventory',
        );
        return this.complete(tx, begun.claim, actor, reason, requestId, {
          type: 'inventory-adjusted',
          resourceId: balanceId,
          version: after.version,
          status: 200,
          snapshot: body,
          beforeMetadata: {
            onHand: before.onHand,
            reserved: before.reserved,
            allocated: before.allocated,
            damaged: before.damaged,
            version: before.version,
          },
          afterMetadata: {
            onHand,
            reserved: before.reserved,
            allocated: before.allocated,
            damaged,
            version: after.version,
          },
        });
      });
    } catch (error) {
      await this.idempotency.fail(begun.claim, 'INVENTORY_COMMAND_FAILED');
      throw error;
    }
  }

  async threshold(
    balanceId: string,
    dto: InventoryThresholdDto,
    expectedVersion: number | undefined,
    actor: Actor,
    key: string | undefined,
    requestId: string,
  ) {
    ensureAdmin(actor);
    boundedInteger(dto.lowStockThreshold, 0, 1_000_000, 'lowStockThreshold');
    const reason = safeReason(dto.reason);
    if (expectedVersion === undefined) throw new HttpException('If-Match is required.', 428);
    const begun = await this.claim(
      {
        operation: 'inventory.threshold',
        request: { balanceId, lowStockThreshold: dto.lowStockThreshold, expectedVersion, reason },
        key,
      },
      actor,
      reason,
      requestId,
    );
    if (begun.kind === 'replay') return this.replay(begun);
    if (begun.kind !== 'acquired')
      throw new InventoryOperationConflict(
        'Another inventory command is already in progress.',
        'INVENTORY_COMMAND_IN_PROGRESS',
      );
    try {
      return await this.serializable(async (tx) => {
        await this.assertPersistedAdmin(tx, actor);
        await tx.$queryRaw`SELECT "id" FROM "InventoryBalance" WHERE "id" = ${balanceId} FOR UPDATE`;
        const before = await tx.inventoryBalance.findUnique({ where: { id: balanceId } });
        if (!before) throw new NotFoundException('Inventory balance not found.');
        if (expectedVersion === undefined || expectedVersion !== before.version)
          throw new InventoryOperationConflict(
            'The inventory balance revision is stale.',
            'INVENTORY_REVISION_CONFLICT',
            before.version,
          );
        assertPgInt(before.version + 1, 'version');
        const after = await tx.inventoryBalance.update({
          where: { id: balanceId },
          data: { lowStockThreshold: dto.lowStockThreshold, version: { increment: 1 } },
        });
        const body = response(
          {
            balanceId,
            lowStockThreshold: after.lowStockThreshold,
            available: after.onHand - after.reserved - after.allocated - after.damaged,
          },
          balanceId,
          after.version,
          200,
          'inventory',
        );
        return this.complete(tx, begun.claim, actor, reason, requestId, {
          type: 'inventory-threshold-changed',
          resourceId: balanceId,
          version: after.version,
          status: 200,
          snapshot: body,
          beforeMetadata: { lowStockThreshold: before.lowStockThreshold, version: before.version },
          afterMetadata: { lowStockThreshold: after.lowStockThreshold, version: after.version },
        });
      });
    } catch (error) {
      await this.idempotency.fail(begun.claim, 'INVENTORY_COMMAND_FAILED');
      throw error;
    }
  }

  async createTransfer(
    dto: CreateInventoryTransferDto,
    actor: Actor,
    key: string | undefined,
    requestId: string,
  ) {
    ensureAdmin(actor);
    for (const line of dto.lines) boundedInteger(line.quantity, 1, 1_000_000, 'quantity');
    const reason = safeReason(dto.reason);
    const ids = new Set(dto.lines.map((line) => line.variantId));
    if (
      ids.size !== dto.lines.length ||
      dto.lines.length < 1 ||
      dto.lines.length > 50 ||
      dto.sourceWarehouseId === dto.destinationWarehouseId
    )
      throw new InventoryOperationInvalid('Transfer lines and warehouses are invalid.');
    const begun = await this.claim(
      {
        operation: 'inventory.transfer.create',
        request: {
          sourceWarehouseId: dto.sourceWarehouseId,
          destinationWarehouseId: dto.destinationWarehouseId,
          lines: dto.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
          reason,
        },
        key,
      },
      actor,
      reason,
      requestId,
    );
    if (begun.kind === 'replay') return this.replay(begun);
    if (begun.kind !== 'acquired')
      throw new InventoryOperationConflict(
        'Another inventory command is already in progress.',
        'INVENTORY_COMMAND_IN_PROGRESS',
      );
    try {
      return await this.serializable(async (tx) => {
        await this.assertPersistedAdmin(tx, actor);
        const warehouses = await tx.warehouse.findMany({
          where: {
            id: { in: [dto.sourceWarehouseId, dto.destinationWarehouseId] },
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (warehouses.length !== 2)
          throw new NotFoundException('Active transfer warehouses were not found.');
        const variants = await tx.productVariant.findMany({
          where: { id: { in: dto.lines.map((line) => line.variantId) }, status: 'ACTIVE' },
          select: { id: true },
        });
        if (variants.length !== dto.lines.length)
          throw new NotFoundException('Active transfer variant was not found.');
        const transfer = await tx.inventoryTransfer.create({
          data: {
            id: randomUUID(),
            sourceWarehouseId: dto.sourceWarehouseId,
            destinationWarehouseId: dto.destinationWarehouseId,
            reason,
            createdBy: actor.id,
            lines: {
              create: dto.lines.map((line) => ({
                variantId: line.variantId,
                quantity: line.quantity,
              })),
            },
          },
          select: transferSelect,
        });
        const body = response({ transfer }, transfer.id, transfer.version, 201, 'transfer');
        return this.complete(tx, begun.claim, actor, reason, requestId, {
          type: 'transfer-requested',
          resourceId: transfer.id,
          transferId: transfer.id,
          version: transfer.version,
          status: 201,
          snapshot: body,
          beforeMetadata: {},
          afterMetadata: {
            status: transfer.status,
            version: transfer.version,
            sourceWarehouseId: transfer.sourceWarehouseId,
            destinationWarehouseId: transfer.destinationWarehouseId,
            lineCount: transfer.lines.length,
            quantityTotal: transfer.lines.reduce((sum, line) => sum + line.quantity, 0),
          },
        });
      });
    } catch (error) {
      await this.idempotency.fail(begun.claim, 'TRANSFER_CREATE_FAILED');
      throw error;
    }
  }

  async transition(
    transferId: string,
    dto: InventoryTransferTransitionDto,
    expectedVersion: number | undefined,
    actor: Actor,
    key: string | undefined,
    requestId: string,
  ) {
    ensureAdmin(actor);
    for (const line of dto.lines ?? []) {
      boundedInteger(line.received, 0, 1_000_000, 'received');
      boundedInteger(line.damaged, 0, 1_000_000, 'damaged');
      boundedInteger(line.lost, 0, 1_000_000, 'lost');
    }
    const reason = safeReason(dto.reason);
    if (expectedVersion === undefined) throw new HttpException('If-Match is required.', 428);
    if (dto.targetStatus !== 'RECEIVED' && dto.lines !== undefined)
      throw new InventoryOperationInvalid('Receipt lines are only valid when receiving.');
    const begun = await this.claim(
      {
        operation: 'inventory.transfer.transition',
        request: {
          transferId,
          targetStatus: dto.targetStatus,
          reason,
          expectedVersion,
          lines: (dto.lines ?? []).map((line) => ({
            variantId: line.variantId,
            received: line.received,
            damaged: line.damaged,
            lost: line.lost,
          })),
        },
        key,
      },
      actor,
      reason,
      requestId,
    );
    if (begun.kind === 'replay') return this.replay(begun);
    if (begun.kind !== 'acquired')
      throw new InventoryOperationConflict(
        'Another inventory command is already in progress.',
        'INVENTORY_COMMAND_IN_PROGRESS',
      );
    try {
      return await this.serializable(async (tx) => {
        await this.assertPersistedAdmin(tx, actor);
        await tx.$queryRaw`SELECT "id" FROM "InventoryTransfer" WHERE "id" = ${transferId} FOR UPDATE`;
        const transfer = await tx.inventoryTransfer.findUnique({
          where: { id: transferId },
          select: transferSelect,
        });
        if (!transfer) throw new NotFoundException('Inventory transfer not found.');
        if (expectedVersion !== transfer.version)
          throw new InventoryOperationConflict(
            'The transfer revision is stale.',
            'INVENTORY_REVISION_CONFLICT',
            transfer.version,
          );
        if (
          dto.targetStatus === 'CANCELLED' &&
          transfer.status !== InventoryTransferStatus.REQUESTED
        )
          throw new InventoryOperationConflict('Only requested transfers can be cancelled.');
        if (dto.targetStatus === 'IN_TRANSIT') {
          if (transfer.status !== InventoryTransferStatus.REQUESTED)
            throw new InventoryOperationConflict('Only requested transfers can dispatch.');
          const lines = [...transfer.lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
          for (const line of lines)
            await tx.$queryRaw`SELECT "id" FROM "InventoryBalance" WHERE "warehouseId" = ${transfer.sourceWarehouseId} AND "variantId" = ${line.variantId} FOR UPDATE`;
          let sequence = 1;
          for (const line of lines) {
            const balance = await tx.inventoryBalance.findUnique({
              where: {
                warehouseId_variantId: {
                  warehouseId: transfer.sourceWarehouseId,
                  variantId: line.variantId,
                },
              },
            });
            if (
              !balance ||
              balance.onHand - balance.reserved - balance.allocated - balance.damaged <
                line.quantity
            )
              throw new InventoryOperationConflict('Insufficient source availability.');
            assertPgInt(balance.onHand - line.quantity, 'onHand');
            assertPgInt(balance.version + 1, 'version');
            await tx.inventoryBalance.update({
              where: { id: balance.id },
              data: { onHand: { decrement: line.quantity }, version: { increment: 1 } },
            });
            await tx.inventoryMovement.create({
              data: {
                warehouseId: transfer.sourceWarehouseId,
                variantId: line.variantId,
                type: InventoryMovementType.TRANSFER_DISPATCH,
                onHandDelta: -line.quantity,
                resultingOnHand: balance.onHand - line.quantity,
                resultingReserved: balance.reserved,
                resultingAllocated: balance.allocated,
                resultingDamaged: balance.damaged,
                commandId: transfer.id,
                commandSequence: sequence++,
                transferLineId: (
                  await tx.inventoryTransferLine.findUniqueOrThrow({
                    where: { transferId_variantId: { transferId, variantId: line.variantId } },
                  })
                ).id,
                actorType: 'STAFF',
                actorId: actor.id,
                reason,
              },
            });
          }
        }
        if (dto.targetStatus === 'RECEIVED') {
          if (
            transfer.status !== InventoryTransferStatus.IN_TRANSIT ||
            !dto.lines ||
            dto.lines.length !== transfer.lines.length
          )
            throw new InventoryOperationConflict('A complete receipt is required.');
          const receipts = new Map(dto.lines.map((line) => [line.variantId, line]));
          if (receipts.size !== transfer.lines.length)
            throw new InventoryOperationInvalid(
              'Receipt lines must identify each transfer line once.',
            );
          const sortedReceiptLines = [...transfer.lines].sort((a, b) =>
            a.variantId.localeCompare(b.variantId),
          );
          for (const line of sortedReceiptLines)
            await tx.$queryRaw`SELECT "id" FROM "InventoryBalance" WHERE "warehouseId" = ${transfer.destinationWarehouseId} AND "variantId" = ${line.variantId} FOR UPDATE`;
          let sequence = 100;
          for (const line of sortedReceiptLines) {
            const receipt = receipts.get(line.variantId);
            if (!receipt || receipt.received + receipt.damaged + receipt.lost !== line.quantity)
              throw new InventoryOperationInvalid(
                'Receipt quantities must conserve each transfer line.',
              );
            const existing = await tx.inventoryBalance.findUnique({
              where: {
                warehouseId_variantId: {
                  warehouseId: transfer.destinationWarehouseId,
                  variantId: line.variantId,
                },
              },
            });
            if (!existing)
              await tx.$executeRaw`INSERT INTO "InventoryBalance" ("id", "warehouseId", "variantId", "onHand", "createdAt", "updatedAt") VALUES (${randomUUID()}, ${transfer.destinationWarehouseId}, ${line.variantId}, 0, NOW(), NOW()) ON CONFLICT ("warehouseId", "variantId") DO NOTHING`;
            const balance =
              existing ??
              (await tx.inventoryBalance.findUniqueOrThrow({
                where: {
                  warehouseId_variantId: {
                    warehouseId: transfer.destinationWarehouseId,
                    variantId: line.variantId,
                  },
                },
              }));
            const transferLine = await tx.inventoryTransferLine.findUniqueOrThrow({
              where: { transferId_variantId: { transferId, variantId: line.variantId } },
            });
            let resultingOnHand = balance.onHand;
            let resultingDamaged = balance.damaged;
            const movements = [
              [InventoryMovementType.TRANSFER_RECEIPT, receipt.received],
              [InventoryMovementType.TRANSFER_DAMAGE, receipt.damaged],
            ] as const;
            const applied = movements.filter(([, delta]) => delta > 0);
            for (const [index, [kind, delta]] of applied.entries()) {
              resultingOnHand += delta;
              if (kind === InventoryMovementType.TRANSFER_DAMAGE) resultingDamaged += delta;
              assertPgInt(resultingOnHand, 'onHand');
              assertPgInt(resultingDamaged, 'damaged');
              assertPgInt(balance.version + index + 1, 'version');
              await tx.inventoryBalance.update({
                where: { id: balance.id },
                data: {
                  onHand: resultingOnHand,
                  damaged: resultingDamaged,
                  version: { increment: 1 },
                },
              });
              await tx.inventoryMovement.create({
                data: {
                  warehouseId: transfer.destinationWarehouseId,
                  variantId: line.variantId,
                  type: kind,
                  onHandDelta: delta,
                  damagedDelta: kind === InventoryMovementType.TRANSFER_DAMAGE ? delta : 0,
                  resultingOnHand,
                  resultingReserved: balance.reserved,
                  resultingAllocated: balance.allocated,
                  resultingDamaged,
                  commandId: transfer.id,
                  commandSequence: sequence++,
                  transferLineId: transferLine.id,
                  actorType: 'STAFF',
                  actorId: actor.id,
                  reason,
                },
              });
            }
            if (applied.length === 0) {
              assertPgInt(balance.version + 1, 'version');
              await tx.inventoryBalance.update({
                where: { id: balance.id },
                data: { version: { increment: 1 } },
              });
            }
            await tx.inventoryTransferLine.update({
              where: { id: transferLine.id },
              data: { received: receipt.received, damaged: receipt.damaged, lost: receipt.lost },
            });
          }
        }
        const next =
          dto.targetStatus === 'IN_TRANSIT'
            ? InventoryTransferStatus.IN_TRANSIT
            : dto.targetStatus === 'RECEIVED'
              ? InventoryTransferStatus.RECEIVED
              : InventoryTransferStatus.CANCELLED;
        assertPgInt(transfer.version + 1, 'version');
        const updated = await tx.inventoryTransfer.update({
          where: { id: transferId },
          data: {
            status: next,
            version: { increment: 1 },
            dispatchedAt: next === InventoryTransferStatus.IN_TRANSIT ? new Date() : undefined,
            receivedAt: next === InventoryTransferStatus.RECEIVED ? new Date() : undefined,
            cancelledAt: next === InventoryTransferStatus.CANCELLED ? new Date() : undefined,
          },
          select: transferSelect,
        });
        const body = response({ transfer: updated }, transferId, updated.version, 200, 'transfer');
        return this.complete(tx, begun.claim, actor, reason, requestId, {
          type:
            dto.targetStatus === 'IN_TRANSIT'
              ? 'transfer-dispatched'
              : dto.targetStatus === 'RECEIVED'
                ? 'transfer-received'
                : 'transfer-cancelled',
          resourceId: transferId,
          transferId,
          version: updated.version,
          status: 200,
          snapshot: body,
          beforeMetadata: {
            status: transfer.status,
            version: transfer.version,
            lineCount: transfer.lines.length,
          },
          afterMetadata: {
            status: updated.status,
            version: updated.version,
            lineCount: updated.lines.length,
            receivedTotal: updated.lines.reduce((sum, line) => sum + (line.received ?? 0), 0),
            damagedTotal: updated.lines.reduce((sum, line) => sum + (line.damaged ?? 0), 0),
            lostTotal: updated.lines.reduce((sum, line) => sum + (line.lost ?? 0), 0),
          },
        });
      });
    } catch (error) {
      await this.idempotency.fail(begun.claim, 'TRANSFER_TRANSITION_FAILED');
      throw error;
    }
  }

  async lowStock(
    actor: Actor,
    query: InventoryOperationsQueryDto = new InventoryOperationsQueryDto(),
  ) {
    ensureAdmin(actor);
    await this.assertPersistedAdmin(this.prisma, actor);
    const take = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
    const cursor = decodeInventoryCursor(this.cursorKey, query.cursor, 'inventory-low-stock');
    const rows = await this.prisma.$queryRaw<
      (LowStockRow & { createdAt: Date; warehouseCode: string; sku: string })[]
    >`
      SELECT b."id", b."warehouseId", b."variantId", b."onHand", b."reserved", b."allocated", b."damaged", b."lowStockThreshold", b."version", b."createdAt", w."code" AS "warehouseCode", v."sku"
      FROM "InventoryBalance" b JOIN "Warehouse" w ON w."id"=b."warehouseId" JOIN "ProductVariant" v ON v."id"=b."variantId"
      WHERE b."onHand" - b."reserved" - b."allocated" - b."damaged" <= b."lowStockThreshold"
      ${query.warehouseCode ? Prisma.sql`AND w."code" = ${query.warehouseCode}` : Prisma.empty}
      ${query.sku ? Prisma.sql`AND v."sku" = ${query.sku}` : Prisma.empty}
      ${cursor ? Prisma.sql`AND (b."createdAt" < ${new Date(cursor.createdAt)} OR (b."createdAt" = ${new Date(cursor.createdAt)} AND b."id" < ${cursor.id}))` : Prisma.empty}
      ORDER BY b."createdAt" DESC, b."id" DESC LIMIT ${take + 1}`;
    const items = rows.slice(0, take).map((row) => ({
      ...row,
      warehouseCode: row.warehouseCode,
      sku: row.sku,
      available: row.onHand - row.reserved - row.allocated - row.damaged,
    }));
    return {
      items,
      nextCursor:
        rows.length > take
          ? encodeInventoryCursor(
              this.cursorKey,
              'inventory-low-stock',
              rows[take - 1].createdAt,
              rows[take - 1].id,
            )
          : null,
      pageScoped: true,
    };
  }
  async reconciliation(
    actor: Actor,
    query: InventoryOperationsQueryDto = new InventoryOperationsQueryDto(),
  ) {
    ensureAdmin(actor);
    await this.assertPersistedAdmin(this.prisma, actor);
    const take = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
    const cursor = decodeInventoryCursor(this.cursorKey, query.cursor, 'inventory-reconciliation');
    return this.prisma.$transaction(
      async (tx) => {
        const balances = await tx.inventoryBalance.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: take + 1,
          where: {
            AND: [
              query.warehouseCode ? { warehouse: { code: query.warehouseCode } } : {},
              query.sku ? { variant: { sku: query.sku } } : {},
              cursor
                ? {
                    OR: [
                      { createdAt: { lt: new Date(cursor.createdAt) } },
                      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
                    ],
                  }
                : {},
            ],
          },
          select: {
            id: true,
            warehouseId: true,
            variantId: true,
            onHand: true,
            reserved: true,
            allocated: true,
            damaged: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        const visibleBalances = balances.slice(0, take);
        const items = await Promise.all(
          visibleBalances.map(async (balance) => {
            const movements = await tx.inventoryMovement.aggregate({
              where: { warehouseId: balance.warehouseId, variantId: balance.variantId },
              _sum: {
                onHandDelta: true,
                reservedDelta: true,
                allocatedDelta: true,
                damagedDelta: true,
              },
            });
            const activeReservations = await tx.inventoryReservationItem.aggregate({
              where: {
                warehouseId: balance.warehouseId,
                variantId: balance.variantId,
                reservation: { status: 'ACTIVE' },
              },
              _sum: { quantity: true },
            });
            const committedReservations = await tx.inventoryReservationItem.aggregate({
              where: {
                warehouseId: balance.warehouseId,
                variantId: balance.variantId,
                reservation: { status: 'COMMITTED' },
              },
              _sum: { quantity: true },
            });
            const shipped = await tx.fulfillmentGroupItem.aggregate({
              where: {
                orderLine: { variantId: balance.variantId },
                fulfillmentGroup: {
                  warehouseId: balance.warehouseId,
                  status: { in: ['SHIPPED', 'DELIVERED'] },
                },
              },
              _sum: { quantity: true },
            });
            const outbound = await tx.inventoryTransferLine.aggregate({
              where: {
                variantId: balance.variantId,
                transfer: {
                  sourceWarehouseId: balance.warehouseId,
                  status: { in: ['IN_TRANSIT', 'RECEIVED'] },
                },
              },
              _sum: { quantity: true },
            });
            const inbound = await tx.inventoryTransferLine.aggregate({
              where: {
                variantId: balance.variantId,
                transfer: { destinationWarehouseId: balance.warehouseId, status: 'RECEIVED' },
              },
              _sum: { received: true, damaged: true, lost: true },
            });
            const inTransitOut = await tx.inventoryTransferLine.aggregate({
              where: {
                variantId: balance.variantId,
                transfer: { sourceWarehouseId: balance.warehouseId, status: 'IN_TRANSIT' },
              },
              _sum: { quantity: true },
            });
            const inTransitIn = await tx.inventoryTransferLine.aggregate({
              where: {
                variantId: balance.variantId,
                transfer: { destinationWarehouseId: balance.warehouseId, status: 'IN_TRANSIT' },
              },
              _sum: { quantity: true },
            });
            const dispatchActual = await tx.inventoryMovement.aggregate({
              where: {
                warehouseId: balance.warehouseId,
                variantId: balance.variantId,
                type: 'TRANSFER_DISPATCH',
              },
              _sum: { onHandDelta: true },
              _count: { _all: true },
            });
            const receiptActual = await tx.inventoryMovement.aggregate({
              where: {
                warehouseId: balance.warehouseId,
                variantId: balance.variantId,
                type: 'TRANSFER_RECEIPT',
              },
              _sum: { onHandDelta: true },
              _count: { _all: true },
            });
            const damageActual = await tx.inventoryMovement.aggregate({
              where: {
                warehouseId: balance.warehouseId,
                variantId: balance.variantId,
                type: 'TRANSFER_DAMAGE',
              },
              _sum: { onHandDelta: true, damagedDelta: true },
              _count: { _all: true },
            });
            const coverageRows = await tx.$queryRaw<
              Array<{
                invalidLineCount: number;
                unlinkedMovementCount: number;
                dispatchCount: number;
                dispatchQuantity: bigint;
                receiptCount: number;
                receiptQuantity: bigint;
                damageCount: number;
                damageQuantity: bigint;
              }>
            >`
              WITH per_line AS (
                SELECT l."id", l."quantity", l."received", l."damaged", l."lost", t."id" AS "transferId", t."status",
                  t."sourceWarehouseId", t."destinationWarehouseId",
                  count(m."id") FILTER (WHERE m."type" IN ('TRANSFER_DISPATCH','TRANSFER_RECEIPT','TRANSFER_DAMAGE'))::int AS "movementCount",
                  count(m."id") FILTER (WHERE m."type"='TRANSFER_DISPATCH')::int AS "dispatchCount",
                  COALESCE(sum(m."onHandDelta") FILTER (WHERE m."type"='TRANSFER_DISPATCH'),0) AS "dispatchQuantity",
                  count(m."id") FILTER (WHERE m."type"='TRANSFER_RECEIPT')::int AS "receiptCount",
                  COALESCE(sum(m."onHandDelta") FILTER (WHERE m."type"='TRANSFER_RECEIPT'),0) AS "receiptQuantity",
                  count(m."id") FILTER (WHERE m."type"='TRANSFER_DAMAGE')::int AS "damageCount",
                  COALESCE(sum(m."damagedDelta") FILTER (WHERE m."type"='TRANSFER_DAMAGE'),0) AS "damageQuantity",
                  COALESCE(sum(m."onHandDelta") FILTER (WHERE m."type"='TRANSFER_DAMAGE'),0) AS "damageOnHandQuantity",
                  count(m."id") FILTER (WHERE m."type" NOT IN ('TRANSFER_DISPATCH','TRANSFER_RECEIPT','TRANSFER_DAMAGE') OR m."commandId"<>t."id" OR m."variantId"<>l."variantId" OR (m."type"='TRANSFER_DISPATCH' AND m."warehouseId"<>t."sourceWarehouseId") OR (m."type" IN ('TRANSFER_RECEIPT','TRANSFER_DAMAGE') AND m."warehouseId"<>t."destinationWarehouseId"))::int AS "invalidMovementCount"
                FROM "InventoryTransferLine" l
                JOIN "InventoryTransfer" t ON t."id"=l."transferId"
                LEFT JOIN "InventoryMovement" m ON m."transferLineId"=l."id"
                WHERE l."variantId"=${balance.variantId} AND (t."sourceWarehouseId"=${balance.warehouseId} OR t."destinationWarehouseId"=${balance.warehouseId})
                GROUP BY l."id",t."id"
              ), checked AS (
                SELECT *,
                  CASE
                    WHEN "status" IN ('REQUESTED','CANCELLED') THEN "movementCount">0 OR "received" IS NOT NULL OR "damaged" IS NOT NULL OR "lost" IS NOT NULL OR "invalidMovementCount">0
                    WHEN "status"='IN_TRANSIT' THEN "dispatchCount"<>1 OR "dispatchQuantity"<>-"quantity" OR "invalidMovementCount">0 OR "receiptCount">0 OR "damageCount">0 OR "received" IS NOT NULL OR "damaged" IS NOT NULL OR "lost" IS NOT NULL
                    WHEN "status"='RECEIVED' THEN "dispatchCount"<>1 OR "dispatchQuantity"<>-"quantity" OR "invalidMovementCount">0 OR "received" IS NULL OR "damaged" IS NULL OR "lost" IS NULL OR "receiptCount" <> CASE WHEN "received">0 THEN 1 ELSE 0 END OR "receiptQuantity"<>"received" OR "damageCount" <> CASE WHEN "damaged">0 THEN 1 ELSE 0 END OR "damageQuantity"<>"damaged" OR "damageOnHandQuantity"<>"damaged" OR "received"+"damaged"+"lost"<>"quantity"
                    ELSE true END AS invalid
                FROM per_line
              )
              SELECT count(*) FILTER (WHERE invalid)::int AS "invalidLineCount",
                (SELECT count(*)::int FROM "InventoryMovement" m WHERE m."transferLineId" IS NULL AND m."type" IN ('TRANSFER_DISPATCH','TRANSFER_RECEIPT','TRANSFER_DAMAGE') AND m."warehouseId"=${balance.warehouseId} AND m."variantId"=${balance.variantId}) AS "unlinkedMovementCount",
                COALESCE(sum("dispatchCount"),0)::int AS "dispatchCount", COALESCE(sum("dispatchQuantity"),0) AS "dispatchQuantity",
                COALESCE(sum("receiptCount"),0)::int AS "receiptCount", COALESCE(sum("receiptQuantity"),0) AS "receiptQuantity",
                COALESCE(sum("damageCount"),0)::int AS "damageCount", COALESCE(sum("damageQuantity"),0) AS "damageQuantity"
              FROM checked`;
            const rawCoverage = coverageRows[0];
            const coverage = rawCoverage
              ? {
                  ...rawCoverage,
                  dispatchQuantity: Number(rawCoverage.dispatchQuantity),
                  receiptQuantity: Number(rawCoverage.receiptQuantity),
                  damageQuantity: Number(rawCoverage.damageQuantity),
                }
              : {
                  invalidLineCount: 0,
                  unlinkedMovementCount: 0,
                  dispatchCount: 0,
                  dispatchQuantity: 0,
                  receiptCount: 0,
                  receiptQuantity: 0,
                  damageCount: 0,
                  damageQuantity: 0,
                };
            const ledger = {
              onHand: movements._sum.onHandDelta ?? 0,
              reserved: movements._sum.reservedDelta ?? 0,
              allocated: movements._sum.allocatedDelta ?? 0,
              damaged: movements._sum.damagedDelta ?? 0,
            };
            const business = {
              reserved: activeReservations._sum.quantity ?? 0,
              allocated: (committedReservations._sum.quantity ?? 0) - (shipped._sum.quantity ?? 0),
            };
            const transfer = {
              expected: {
                outbound: outbound._sum.quantity ?? 0,
                inboundReceived: inbound._sum.received ?? 0,
                inboundDamaged: inbound._sum.damaged ?? 0,
                inboundLost: inbound._sum.lost ?? 0,
              },
              actual: {
                dispatched: Math.abs(dispatchActual._sum.onHandDelta ?? 0),
                received: receiptActual._sum.onHandDelta ?? 0,
                damaged: damageActual._sum.damagedDelta ?? 0,
              },
              inTransit: {
                sourceOutbound: inTransitOut._sum.quantity ?? 0,
                destinationInbound: inTransitIn._sum.quantity ?? 0,
              },
              movementCoverage: coverage,
            };
            const mismatchCategories = [
              ...(ledger.onHand !== balance.onHand ? ['LEDGER_ON_HAND'] : []),
              ...(ledger.reserved !== balance.reserved ? ['LEDGER_RESERVED'] : []),
              ...(ledger.allocated !== balance.allocated ? ['LEDGER_ALLOCATED'] : []),
              ...(ledger.damaged !== balance.damaged ? ['LEDGER_DAMAGED'] : []),
              ...(business.reserved !== balance.reserved ? ['ACTIVE_RESERVATION'] : []),
              ...(business.allocated !== balance.allocated ? ['UNSHIPPED_ALLOCATION'] : []),
              ...(transfer.actual.dispatched !== transfer.expected.outbound
                ? ['TRANSFER_DISPATCH_MISMATCH']
                : []),
              ...(transfer.actual.received !== transfer.expected.inboundReceived
                ? ['TRANSFER_RECEIPT_MISMATCH']
                : []),
              ...(transfer.actual.damaged !== transfer.expected.inboundDamaged ||
              (damageActual._sum.onHandDelta ?? 0) !== transfer.expected.inboundDamaged
                ? ['TRANSFER_DAMAGE_MISMATCH']
                : []),
              ...(coverage.invalidLineCount > 0 || coverage.unlinkedMovementCount > 0
                ? ['TRANSFER_MOVEMENT_COVERAGE']
                : []),
            ];
            return {
              balanceId: balance.id,
              ledger,
              business,
              transfer,
              actual: balance,
              mismatchCategories,
              mismatch: mismatchCategories.length > 0,
            };
          }),
        );
        const visible = items;
        return {
          items: visible,
          nextCursor:
            balances.length > take
              ? encodeInventoryCursor(
                  this.cursorKey,
                  'inventory-reconciliation',
                  visibleBalances[take - 1].createdAt,
                  visibleBalances[take - 1].id,
                )
              : null,
          pageScoped: true,
          scanned: visible.length,
          mismatchCount: visible.filter((item) => item.mismatch).length,
          clean: visible.every((item) => !item.mismatch),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async listTransfers(
    actor: Actor,
    query: InventoryOperationsQueryDto = new InventoryOperationsQueryDto(),
  ) {
    ensureAdmin(actor);
    await this.assertPersistedAdmin(this.prisma, actor);
    const take = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
    const cursor = decodeInventoryCursor(this.cursorKey, query.cursor, 'inventory-transfers');
    const rows = await this.prisma.inventoryTransfer.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      where: {
        AND: [
          query.warehouseCode
            ? {
                OR: [
                  { sourceWarehouse: { code: query.warehouseCode } },
                  { destinationWarehouse: { code: query.warehouseCode } },
                ],
              }
            : {},
          query.sku ? { lines: { some: { variant: { sku: query.sku } } } } : {},
          cursor
            ? {
                OR: [
                  { createdAt: { lt: new Date(cursor.createdAt) } },
                  { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      select: transferSelect,
    });
    const items = rows.slice(0, take);
    return {
      items,
      nextCursor:
        rows.length > take
          ? encodeInventoryCursor(
              this.cursorKey,
              'inventory-transfers',
              rows[take - 1].createdAt,
              rows[take - 1].id,
            )
          : null,
      pageScoped: true,
    };
  }
  async getTransfer(id: string, actor: Actor) {
    ensureAdmin(actor);
    await this.assertPersistedAdmin(this.prisma, actor);
    const transfer = await this.prisma.inventoryTransfer.findUnique({
      where: { id },
      select: transferSelect,
    });
    if (!transfer) throw new NotFoundException('Inventory transfer not found.');
    return transfer;
  }
}
