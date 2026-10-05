import { randomUUID } from 'node:crypto';
import { seedInternationalCommerce } from '../../prisma/seed-international-commerce';
import { seedPhase3Commerce } from '../../prisma/seed-commerce';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { IdempotencyRetentionService } from '../idempotency/idempotency-retention.service';
import { InventoryOperationsService } from './inventory-operations.service';
import { RoleName } from '../generated/prisma/enums';
import {
  InventoryAdjustmentDto,
  CreateInventoryTransferDto,
  InventoryTransferTransitionDto,
} from './inventory-operations.dto';
import { resolveIntegrationDatabaseUrl } from '../testing/integration-database-url';
import { CartService } from '../cart/cart.service';
import { CheckoutService } from '../checkout/checkout.service';
import { CheckoutConflictError } from '../checkout/checkout.errors';
import { StubPaymentProvider } from '../payments/stub-payment.provider';
import { OrderTimelineService } from '../orders/order-timeline.service';
import { CommercePolicyLifecycle } from '../generated/prisma/enums';
import { InventoryOperationConflict } from './inventory-operations.errors';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { FulfillmentGroupStatus } from '../generated/prisma/enums';

const developmentDatabaseUrl = process.env.DATABASE_URL;
const explicitTestDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!developmentDatabaseUrl || !explicitTestDatabaseUrl)
  throw new Error('DATABASE_URL and explicit TEST_DATABASE_URL are required.');
const testDatabaseUrl = resolveIntegrationDatabaseUrl(
  developmentDatabaseUrl,
  explicitTestDatabaseUrl,
);

describe('inventory operations isolated PostgreSQL integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const audit = new AuditService();
  const idempotency = new IdempotencyService(prisma);
  const service = new InventoryOperationsService(
    prisma,
    idempotency,
    audit,
    Buffer.alloc(32, 7).toString('base64'),
  );
  const retention = new IdempotencyRetentionService(prisma, audit);
  const carts = new CartService(prisma);
  const checkout = new CheckoutService(
    prisma,
    idempotency,
    audit,
    new StubPaymentProvider(),
    new OrderTimelineService(prisma, Buffer.alloc(32, 8).toString('base64')),
  );
  const fulfillment = new FulfillmentService(prisma, idempotency, audit);
  const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const actor = { id: actorId, roles: [RoleName.ADMINISTRATOR] };
  let balanceId: string;
  let variantId: string;
  let secondVariantId: string;
  let sourceWarehouseId: string;
  let destinationWarehouseId: string;
  let initialOnHand: number;
  let initialVersion: number;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "InventoryCommandResult", "IdempotencyRecord", "AuditRecord", "InventoryTransfer", "FulfillmentGroupItem", "FulfillmentGroup", "PaymentAttempt", "OrderLine", "Order", "InventoryReservationItem", "InventoryReservation", "CartItem", "Cart", "CommercePolicyVersion", "InventoryMovement", "InventoryBalance", "InventoryAllocationPolicyWarehouse", "InventoryAllocationPolicyVersion", "InventoryAllocationPolicy", "Warehouse", "VariantPrice", "PriceBookVersion", "PriceBook", "ProductMedia", "ProductCategory", "Category", "ProductVariant", "ProductSlug", "Product" CASCADE',
    );
    await seedPhase3Commerce(prisma);
    await seedInternationalCommerce(prisma);
    const variants = await prisma.productVariant.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { id: 'asc' },
      take: 2,
    });
    const variant = variants[0];
    const source = await prisma.warehouse.findUniqueOrThrow({ where: { code: 'US-EAST-01' } });
    const destination = await prisma.warehouse.findUniqueOrThrow({
      where: { code: 'EU-CENTRAL-01' },
    });
    variantId = variant.id;
    secondVariantId = variants[1].id;
    sourceWarehouseId = source.id;
    destinationWarehouseId = destination.id;
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_variantId: { warehouseId: sourceWarehouseId, variantId } },
    });
    balanceId = balance.id;
    await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        warehouseId_variantId: { warehouseId: sourceWarehouseId, variantId: secondVariantId },
      },
    });
    initialOnHand = balance.onHand;
    initialVersion = balance.version;
    await prisma.user.upsert({
      where: { id: actorId },
      update: { status: 'ACTIVE', verifiedAt: new Date() },
      create: {
        id: actorId,
        emailNormalized: `${actorId}@example.test`,
        passwordHash: 'integration-only',
        status: 'ACTIVE',
        verifiedAt: new Date(),
        userRoles: { create: { role: RoleName.ADMINISTRATOR } },
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('adjusts stock atomically and persists movement, audit, and immutable replay', async () => {
    const dto = Object.assign(new InventoryAdjustmentDto(), {
      onHandDelta: -2,
      damagedDelta: 1,
      reason: 'Integration stock recount',
    });
    const key = `inventory-${randomUUID()}`;
    const result = await service.adjust(
      balanceId,
      dto,
      initialVersion,
      actor,
      key,
      'inventory-integration-adjust',
    );
    expect(result).toMatchObject({
      balanceId,
      onHand: initialOnHand - 2,
      version: initialVersion + 1,
      etag: `"inventory-${initialVersion + 1}"`,
    });
    await expect(
      prisma.inventoryMovement.findFirst({
        where: { warehouseId: sourceWarehouseId, variantId, type: 'ADJUSTMENT' },
      }),
    ).resolves.toMatchObject({ onHandDelta: -2, damagedDelta: 1 });
    await expect(
      prisma.auditRecord.findFirst({ where: { actorId, action: 'inventory.inventory-adjusted' } }),
    ).resolves.not.toBeNull();
    const replay = await service.adjust(
      balanceId,
      dto,
      initialVersion,
      actor,
      key,
      'inventory-integration-adjust-replay',
    );
    expect(replay).toEqual(result);
    await expect(
      service.adjust(
        balanceId,
        Object.assign(new InventoryAdjustmentDto(), {
          onHandDelta: -1,
          damagedDelta: 1,
          reason: 'Changed payload',
        }),
        initialVersion,
        actor,
        key,
        'inventory-integration-adjust-conflict',
      ),
    ).rejects.toThrow();
    await expect(
      service.adjust(
        balanceId,
        Object.assign(new InventoryAdjustmentDto(), {
          onHandDelta: -1000000,
          damagedDelta: 0,
          reason: 'Insufficient stock command',
        }),
        initialVersion + 1,
        actor,
        `invalid-${randomUUID()}`,
        'inventory-integration-invalid',
      ),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } }),
    ).resolves.toMatchObject({ onHand: initialOnHand - 2, version: initialVersion + 1 });
  });

  it('walks all seeded balances through stable reconciliation pages', async () => {
    const first = await service.reconciliation(actor, { pageSize: 100 });
    expect(first.items).toHaveLength(100);
    expect(first.pageScoped).toBe(true);
    expect(first.clean).toBe(true);
    expect(first.mismatchCount).toBe(0);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.reconciliation(actor, {
      pageSize: 100,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(20);
    expect(second.nextCursor).toBeNull();
    expect(second.clean).toBe(true);
    expect(second.mismatchCount).toBe(0);
    expect(new Set([...first.items, ...second.items].map((item) => item.balanceId)).size).toBe(120);
  });

  it('creates a multiline transfer without stock effect, dispatches exact lines, and records mixed receipt quantities', async () => {
    const dto = Object.assign(new CreateInventoryTransferDto(), {
      sourceWarehouseId,
      destinationWarehouseId,
      lines: [
        { variantId, quantity: 3 },
        { variantId: secondVariantId, quantity: 2 },
      ],
      reason: 'Integration transfer request',
    });
    const createKey = `transfer-${randomUUID()}`;
    const created = await service.createTransfer(
      dto,
      actor,
      createKey,
      'inventory-integration-transfer',
    );
    const transferId = (created as { transfer: { id: string } }).transfer.id;
    await expect(
      prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } }),
    ).resolves.toMatchObject({ onHand: initialOnHand });
    const dispatched = Object.assign(new InventoryTransferTransitionDto(), {
      targetStatus: 'IN_TRANSIT',
      reason: 'Integration dispatch',
    });
    await service.transition(
      transferId,
      dispatched,
      1,
      actor,
      `dispatch-${randomUUID()}`,
      'inventory-integration-dispatch',
    );
    for (const warehouseCode of ['US-EAST-01', 'EU-CENTRAL-01']) {
      const report = await service.reconciliation(actor, { pageSize: 100, warehouseCode });
      const transferItems = report.items.filter(
        (entry) =>
          entry.transfer.expected.outbound > 0 ||
          entry.transfer.inTransit.sourceOutbound > 0 ||
          entry.transfer.inTransit.destinationInbound > 0,
      );
      expect(report.clean).toBe(true);
      expect(report.mismatchCount).toBe(0);
      expect(transferItems.length).toBeGreaterThan(0);
      expect(
        transferItems.every(
          (entry) =>
            entry.transfer.movementCoverage.invalidLineCount === 0 &&
            entry.transfer.movementCoverage.unlinkedMovementCount === 0,
        ),
      ).toBe(true);
      if (warehouseCode === 'US-EAST-01') {
        expect(
          transferItems.reduce((sum, entry) => sum + entry.transfer.expected.outbound, 0),
        ).toBe(5);
        expect(
          transferItems.reduce((sum, entry) => sum + entry.transfer.actual.dispatched, 0),
        ).toBe(5);
        expect(
          transferItems.reduce((sum, entry) => sum + entry.transfer.inTransit.sourceOutbound, 0),
        ).toBe(5);
      } else {
        expect(
          transferItems.reduce(
            (sum, entry) => sum + entry.transfer.inTransit.destinationInbound,
            0,
          ),
        ).toBe(5);
        expect(
          transferItems.every(
            (entry) => entry.transfer.actual.received === 0 && entry.transfer.actual.damaged === 0,
          ),
        ).toBe(true);
      }
    }
    const received = Object.assign(new InventoryTransferTransitionDto(), {
      targetStatus: 'RECEIVED',
      reason: 'Integration receipt',
      lines: [
        { variantId, received: 1, damaged: 1, lost: 1 },
        { variantId: secondVariantId, received: 0, damaged: 0, lost: 2 },
      ],
    });
    const receiveKey = `receive-${randomUUID()}`;
    const receivedResult = await service.transition(
      transferId,
      received,
      2,
      actor,
      receiveKey,
      'inventory-integration-receive',
    );
    await expect(prisma.inventoryTransferLine.count({ where: { transferId } })).resolves.toBe(2);
    await expect(
      prisma.inventoryTransferLine.findFirstOrThrow({ where: { transferId, variantId } }),
    ).resolves.toMatchObject({ received: 1, damaged: 1, lost: 1 });
    await expect(
      prisma.inventoryTransferLine.findFirstOrThrow({
        where: { transferId, variantId: secondVariantId },
      }),
    ).resolves.toMatchObject({ received: 0, damaged: 0, lost: 2 });
    await expect(
      prisma.inventoryMovement.count({ where: { commandId: transferId } }),
    ).resolves.toBe(4);
    expect(
      await service.createTransfer(dto, actor, createKey, 'inventory-integration-transfer-replay'),
    ).toEqual(created);
    expect(
      await service.transition(
        transferId,
        received,
        2,
        actor,
        receiveKey,
        'inventory-integration-receive-replay',
      ),
    ).toEqual(receivedResult);
    const movementsAfterReceipt = await prisma.inventoryMovement.count({
      where: { commandId: transferId },
    });
    await expect(
      service.transition(
        transferId,
        received,
        3,
        actor,
        `receive-terminal-${randomUUID()}`,
        'inventory-integration-terminal-receive',
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_OPERATION_CONFLICT' });
    await expect(
      prisma.inventoryMovement.count({ where: { commandId: transferId } }),
    ).resolves.toBe(movementsAfterReceipt);
    for (const warehouseCode of ['US-EAST-01', 'EU-CENTRAL-01']) {
      const report = await service.reconciliation(actor, { pageSize: 100, warehouseCode });
      expect(report.clean).toBe(true);
      const transferItems = report.items.filter(
        (entry) =>
          entry.transfer.expected.outbound > 0 ||
          entry.transfer.expected.inboundReceived > 0 ||
          entry.transfer.expected.inboundDamaged > 0 ||
          entry.transfer.expected.inboundLost > 0,
      );
      expect(transferItems.length).toBeGreaterThan(0);
      if (warehouseCode === 'US-EAST-01') {
        expect(
          transferItems.reduce((sum, entry) => sum + entry.transfer.expected.outbound, 0),
        ).toBe(5);
        expect(
          transferItems.reduce((sum, entry) => sum + entry.transfer.actual.dispatched, 0),
        ).toBe(5);
        expect(transferItems.every((entry) => entry.transfer.inTransit.sourceOutbound === 0)).toBe(
          true,
        );
      } else {
        expect(
          transferItems.reduce((sum, entry) => sum + entry.transfer.expected.inboundReceived, 0),
        ).toBe(1);
        expect(
          transferItems.reduce((sum, entry) => sum + entry.transfer.expected.inboundDamaged, 0),
        ).toBe(1);
        expect(
          transferItems.reduce((sum, entry) => sum + entry.transfer.expected.inboundLost, 0),
        ).toBe(3);
        expect(transferItems.reduce((sum, entry) => sum + entry.transfer.actual.received, 0)).toBe(
          1,
        );
        expect(transferItems.reduce((sum, entry) => sum + entry.transfer.actual.damaged, 0)).toBe(
          1,
        );
        expect(
          transferItems.every((entry) => entry.transfer.inTransit.destinationInbound === 0),
        ).toBe(true);
      }
    }
  });

  it('rejects stale and revoked administrator commands without changing the balance', async () => {
    const before = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const dto = Object.assign(new InventoryAdjustmentDto(), {
      onHandDelta: 1,
      damagedDelta: 0,
      reason: 'Rejected stale command',
    });
    await expect(
      service.adjust(
        balanceId,
        dto,
        before.version - 1,
        actor,
        `stale-${randomUUID()}`,
        'inventory-integration-stale',
      ),
    ).rejects.toThrow();
    await prisma.user.update({ where: { id: actorId }, data: { status: 'SUSPENDED' } });
    await expect(
      service.adjust(
        balanceId,
        dto,
        before.version,
        actor,
        `revoked-${randomUUID()}`,
        'inventory-integration-revoked',
      ),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } }),
    ).resolves.toMatchObject({ version: before.version, onHand: before.onHand });
    await prisma.user.update({ where: { id: actorId }, data: { status: 'ACTIVE' } });
  });

  it('rolls back stock, movement, and command result when audit append fails', async () => {
    const before = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const counts = await Promise.all([
      prisma.inventoryMovement.count(),
      prisma.inventoryCommandResult.count(),
      prisma.auditRecord.count(),
    ]);
    jest.spyOn(audit, 'append').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      service.adjust(
        balanceId,
        Object.assign(new InventoryAdjustmentDto(), {
          onHandDelta: 1,
          damagedDelta: 0,
          reason: 'Rollback audit failure',
        }),
        before.version,
        actor,
        `audit-fail-${randomUUID()}`,
        'inventory-integration-audit-fail',
      ),
    ).rejects.toThrow('audit unavailable');
    expect(
      await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } }),
    ).toMatchObject({ onHand: before.onHand, version: before.version });
    await expect(
      Promise.all([
        prisma.inventoryMovement.count(),
        prisma.inventoryCommandResult.count(),
        prisma.auditRecord.count(),
      ]),
    ).resolves.toEqual(counts);
    (audit.append as jest.Mock).mockRestore();
  });

  it('replays the original JSON after a later mutation with its original ETag', async () => {
    const before = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const key = `replay-${randomUUID()}`;
    const dto = Object.assign(new InventoryAdjustmentDto(), {
      onHandDelta: 1,
      damagedDelta: 0,
      reason: 'Replay original',
    });
    const original = await service.adjust(
      balanceId,
      dto,
      before.version,
      actor,
      key,
      'inventory-integration-replay',
    );
    const after = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    await service.threshold(
      balanceId,
      Object.assign({ lowStockThreshold: 2, reason: 'Later threshold' }),
      after.version,
      actor,
      `later-${randomUUID()}`,
      'inventory-integration-later',
    );
    const replay = await service.adjust(
      balanceId,
      dto,
      before.version,
      actor,
      key,
      'inventory-integration-replay-again',
    );
    expect(replay).toEqual(original);
    expect((replay as { etag: string }).etag).toBe(`"inventory-${before.version + 1}"`);
  });

  it('cancels a requested transfer without stock effect and rejects terminal redispatch', async () => {
    const before = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const created = await service.createTransfer(
      Object.assign(new CreateInventoryTransferDto(), {
        sourceWarehouseId,
        destinationWarehouseId,
        lines: [{ variantId, quantity: 1 }],
        reason: 'Cancel requested transfer',
      }),
      actor,
      `cancel-create-${randomUUID()}`,
      'inventory-integration-cancel-create',
    );
    const transferId = (created as { transfer: { id: string } }).transfer.id;
    await service.transition(
      transferId,
      Object.assign(new InventoryTransferTransitionDto(), {
        targetStatus: 'CANCELLED',
        reason: 'Cancel requested transfer',
      }),
      1,
      actor,
      `cancel-${randomUUID()}`,
      'inventory-integration-cancel',
    );
    await expect(
      prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } }),
    ).resolves.toMatchObject({ onHand: before.onHand, version: before.version });
    await expect(
      service.transition(
        transferId,
        Object.assign(new InventoryTransferTransitionDto(), {
          targetStatus: 'IN_TRANSIT',
          reason: 'Illegal redispatch',
        }),
        2,
        actor,
        `redispatch-${randomUUID()}`,
        'inventory-integration-redispatch',
      ),
    ).rejects.toThrow();
  });

  it('rejects a multiline dispatch atomically when a later line is unavailable', async () => {
    const before = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const created = await service.createTransfer(
      Object.assign(new CreateInventoryTransferDto(), {
        sourceWarehouseId,
        destinationWarehouseId,
        lines: [
          { variantId, quantity: 1 },
          { variantId: secondVariantId, quantity: 1000000 },
        ],
        reason: 'Atomic insufficient multiline',
      }),
      actor,
      `atomic-create-${randomUUID()}`,
      'inventory-integration-atomic-create',
    );
    const transferId = (created as { transfer: { id: string } }).transfer.id;
    await expect(
      service.transition(
        transferId,
        Object.assign(new InventoryTransferTransitionDto(), {
          targetStatus: 'IN_TRANSIT',
          reason: 'Atomic insufficient dispatch',
        }),
        1,
        actor,
        `atomic-dispatch-${randomUUID()}`,
        'inventory-integration-atomic-dispatch',
      ),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } }),
    ).resolves.toMatchObject({ onHand: before.onHand, version: before.version });
    await expect(
      prisma.inventoryMovement.count({ where: { commandId: transferId } }),
    ).resolves.toBe(0);
  });

  it('rejects direct result deletion while retention purges expired idempotency parents', async () => {
    const before = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const key = `retention-${randomUUID()}`;
    await service.adjust(
      balanceId,
      Object.assign(new InventoryAdjustmentDto(), {
        onHandDelta: 1,
        damagedDelta: 0,
        reason: 'Retention snapshot',
      }),
      before.version,
      actor,
      key,
      'inventory-integration-retention',
    );
    const record = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { actorId, operation: 'inventory.adjustment', keyDigest: { not: '' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, resultId: true },
    });
    await expect(
      prisma.inventoryCommandResult.delete({ where: { id: record.resultId! } }),
    ).rejects.toThrow();
    const expiredCreatedAt = new Date(Date.now() - 86_400_000 * 2);
    await prisma.idempotencyRecord.update({
      where: { id: record.id },
      data: { createdAt: expiredCreatedAt, expiresAt: new Date(Date.now() - 86_400_000) },
    });
    await expect(
      retention.purgeExpired(10, {
        actor: { type: 'system', id: 'retention', roles: ['IDEMPOTENCY_RETENTION'] },
        idempotencyKey: `retention-purge-${randomUUID()}`,
        requestId: 'retention-request',
        correlationId: 'retention-correlation',
        reason: 'Apply retention policy.',
      }),
    ).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      prisma.inventoryCommandResult.findUnique({ where: { id: record.resultId! } }),
    ).resolves.toBeNull();
  });

  it('concurrently receives separate transfers from different administrators into one missing destination balance', async () => {
    const secondActorId = randomUUID();
    const secondActor = { id: secondActorId, roles: [RoleName.ADMINISTRATOR] };
    const destination = await prisma.warehouse.create({
      data: {
        code: `INT-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Integration destination',
        countryCode: 'US',
        fulfillmentRegion: 'US',
        status: 'ACTIVE',
      },
    });
    await prisma.user.create({
      data: {
        id: secondActorId,
        emailNormalized: `${secondActorId}@example.test`,
        passwordHash: 'integration-only',
        status: 'ACTIVE',
        verifiedAt: new Date(),
        userRoles: { create: { role: RoleName.ADMINISTRATOR } },
      },
    });
    const makeTransfer = async (owner: typeof actor, suffix: string) => {
      const created = await service.createTransfer(
        Object.assign(new CreateInventoryTransferDto(), {
          sourceWarehouseId,
          destinationWarehouseId: destination.id,
          lines: [{ variantId, quantity: 2 }],
          reason: `Concurrent ${suffix}`,
        }),
        owner,
        `concurrent-create-${suffix}-${randomUUID()}`,
        `integration-concurrent-create-${suffix}`,
      );
      const id = (created as { transfer: { id: string } }).transfer.id;
      await service.transition(
        id,
        Object.assign(new InventoryTransferTransitionDto(), {
          targetStatus: 'IN_TRANSIT',
          reason: `Dispatch ${suffix}`,
        }),
        1,
        owner,
        `concurrent-dispatch-${suffix}-${randomUUID()}`,
        `integration-concurrent-dispatch-${suffix}`,
      );
      return id;
    };
    const [firstId, secondId] = await Promise.all([
      makeTransfer(actor, 'one'),
      makeTransfer(secondActor, 'two'),
    ]);
    const receive = (id: string, owner: typeof actor, suffix: string) =>
      service.transition(
        id,
        Object.assign(new InventoryTransferTransitionDto(), {
          targetStatus: 'RECEIVED',
          reason: `Receive ${suffix}`,
          lines: [{ variantId, received: 2, damaged: 0, lost: 0 }],
        }),
        2,
        owner,
        `concurrent-receive-${suffix}-${randomUUID()}`,
        `integration-concurrent-receive-${suffix}`,
      );
    await Promise.all([receive(firstId, actor, 'one'), receive(secondId, secondActor, 'two')]);
    await expect(
      prisma.inventoryBalance.findUniqueOrThrow({
        where: { warehouseId_variantId: { warehouseId: destination.id, variantId } },
      }),
    ).resolves.toMatchObject({ onHand: 4, damaged: 0 });
    await expect(
      prisma.inventoryMovement.count({
        where: { warehouseId: destination.id, variantId, type: 'TRANSFER_RECEIPT' },
      }),
    ).resolves.toBe(2);
    await prisma.userRole.deleteMany({ where: { userId: secondActorId } });
    await prisma.user.delete({ where: { id: secondActorId } });
  });

  it('rejects direct SQL lifecycle and identity rewrites before they can alter transfer state', async () => {
    const created = await service.createTransfer(
      Object.assign(new CreateInventoryTransferDto(), {
        sourceWarehouseId,
        destinationWarehouseId,
        lines: [{ variantId, quantity: 1 }],
        reason: 'SQL guard fixture',
      }),
      actor,
      `sql-guard-${randomUUID()}`,
      'integration-sql-guard',
    );
    const transferId = (created as { transfer: { id: string } }).transfer.id;
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "InventoryTransfer" SET "destinationWarehouseId" = '${sourceWarehouseId}' WHERE "id" = '${transferId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "InventoryTransfer" SET "status" = 'RECEIVED' WHERE "id" = '${transferId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: transferId } }),
    ).resolves.toMatchObject({ status: 'REQUESTED', version: 1, destinationWarehouseId });
  });

  it('rejects direct lifecycle and movement-link corruption with transfer coverage guards', async () => {
    const created = await service.createTransfer(
      Object.assign(new CreateInventoryTransferDto(), {
        sourceWarehouseId,
        destinationWarehouseId,
        lines: [{ variantId, quantity: 1 }],
        reason: 'Coverage SQL guard',
      }),
      actor,
      `coverage-sql-${randomUUID()}`,
      'integration-coverage-sql-create',
    );
    const transferId = (created as { transfer: { id: string } }).transfer.id;
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "InventoryTransfer" SET "status" = 'IN_TRANSIT', "version" = 2, "dispatchedAt" = NOW() WHERE "id" = '${transferId}'`,
      ),
    ).rejects.toThrow(/dispatch coverage mismatch/i);
    await expect(
      prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: transferId } }),
    ).resolves.toMatchObject({ status: 'REQUESTED', version: 1 });
    await service.transition(
      transferId,
      Object.assign(new InventoryTransferTransitionDto(), {
        targetStatus: 'IN_TRANSIT',
        reason: 'Valid dispatch',
      }),
      1,
      actor,
      `coverage-sql-dispatch-${randomUUID()}`,
      'integration-coverage-sql-dispatch',
    );
    const malformedCreated = await service.createTransfer(
      Object.assign(new CreateInventoryTransferDto(), {
        sourceWarehouseId,
        destinationWarehouseId,
        lines: [{ variantId, quantity: 1 }],
        reason: 'Malformed movement fixture',
      }),
      actor,
      `coverage-sql-malformed-${randomUUID()}`,
      'integration-coverage-sql-malformed-create',
    );
    const malformedTransferId = (malformedCreated as { transfer: { id: string } }).transfer.id;
    const malformedLine = await prisma.inventoryTransferLine.findFirstOrThrow({
      where: { transferId: malformedTransferId },
    });
    const destinationBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_variantId: { warehouseId: destinationWarehouseId, variantId } },
    });
    const sourceBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_variantId: { warehouseId: sourceWarehouseId, variantId } },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "InventoryMovement" ("id", "warehouseId", "variantId", "type", "onHandDelta", "reservedDelta", "allocatedDelta", "damagedDelta", "resultingOnHand", "resultingReserved", "resultingAllocated", "resultingDamaged", "commandId", "commandSequence", "transferLineId", "actorType", "actorId", "reason") VALUES ('${randomUUID()}', '${destinationWarehouseId}', '${variantId}', 'TRANSFER_DISPATCH', -1, 0, 0, 0, ${destinationBalance.onHand}, ${destinationBalance.reserved}, ${destinationBalance.allocated}, ${destinationBalance.damaged}, '${malformedTransferId}', 1, '${malformedLine.id}', 'STAFF', '${actorId}', 'Wrong warehouse movement')`,
      ),
    ).rejects.toThrow('transfer movement does not match transfer line');
    const wrongCommandId = randomUUID();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "InventoryMovement" ("id", "warehouseId", "variantId", "type", "onHandDelta", "reservedDelta", "allocatedDelta", "damagedDelta", "resultingOnHand", "resultingReserved", "resultingAllocated", "resultingDamaged", "commandId", "commandSequence", "transferLineId", "actorType", "actorId", "reason") VALUES ('${randomUUID()}', '${sourceWarehouseId}', '${variantId}', 'TRANSFER_DISPATCH', -1, 0, 0, 0, ${sourceBalance.onHand}, ${sourceBalance.reserved}, ${sourceBalance.allocated}, ${sourceBalance.damaged}, '${wrongCommandId}', 2, '${malformedLine.id}', 'STAFF', '${actorId}', 'Wrong command movement')`,
      ),
    ).rejects.toThrow('transfer movement command mismatch');
    await expect(
      prisma.inventoryMovement.count({ where: { transferLineId: malformedLine.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.inventoryMovement.count({ where: { commandId: malformedTransferId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "InventoryTransfer" SET "status" = 'RECEIVED', "version" = 3, "receivedAt" = NOW() WHERE "id" = '${transferId}'`,
      ),
    ).rejects.toThrow(/receipt conservation mismatch/i);
    await expect(
      prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: transferId } }),
    ).resolves.toMatchObject({ status: 'IN_TRANSIT', version: 2 });
  });

  it('includes a zero-available threshold-zero balance in low-stock attention', async () => {
    const before = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const available = before.onHand - before.reserved - before.allocated - before.damaged;
    if (available !== 0)
      await service.adjust(
        balanceId,
        Object.assign(new InventoryAdjustmentDto(), {
          onHandDelta: -available,
          damagedDelta: 0,
          reason: 'Drain to zero available',
        }),
        before.version,
        actor,
        `low-stock-drain-${randomUUID()}`,
        'inventory-integration-low-stock-drain',
      );
    const current = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    await service.threshold(
      balanceId,
      Object.assign({ lowStockThreshold: 0, reason: 'Zero threshold attention' }),
      current.version,
      actor,
      `low-stock-threshold-${randomUUID()}`,
      'inventory-integration-low-stock-threshold',
    );
    const report = await service.lowStock(actor, { pageSize: 100, warehouseCode: 'US-EAST-01' });
    expect(
      report.items.some(
        (item) => item.id === balanceId && item.available === 0 && item.lowStockThreshold === 0,
      ),
    ).toBe(true);
  });

  it('keeps checkout allocation and shipment reconciliation coherent', async () => {
    const priceBookVersion = await prisma.priceBookVersion.findFirstOrThrow({
      where: {
        version: 1,
        lifecycle: 'ACTIVE',
        priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
      },
    });
    const activePolicy = await prisma.commercePolicyVersion.findFirst({
      where: { lifecycle: CommercePolicyLifecycle.ACTIVE, countryCode: 'US', currencyCode: 'USD' },
    });
    if (!activePolicy)
      await prisma.commercePolicyVersion.create({
        data: {
          id: randomUUID(),
          version: 1,
          lifecycle: CommercePolicyLifecycle.ACTIVE,
          effectiveFrom: new Date(),
          countryCode: 'US',
          currencyCode: 'USD',
          priceBookVersionId: priceBookVersion.id,
          shippingBaseMinor: 800,
          freeShippingThresholdMinor: 12000,
          heavySurchargeMinor: 400,
          heavyThresholdGrams: 2000,
          taxRateBasisPoints: 825,
          reservationDurationSeconds: 600,
          calculationVersion: `recon-${randomUUID()}`,
        },
      });
    const current = await carts.getCurrent(undefined);
    const cart = await carts.setItem(current.token, variantId, 1, current.cart.revision);
    const preview = await checkout.preview(cart.token, cart.revision, {
      shippingAddress: {
        fullName: 'Inventory journey',
        line1: '1 Main Street',
        line2: '',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94105',
        countryCode: 'US',
      },
    });
    const confirmed = await checkout.create(
      cart.token,
      cart.revision,
      `recon-checkout-${randomUUID()}`,
      {
        shippingAddress: {
          fullName: 'Inventory journey',
          line1: '1 Main Street',
          line2: '',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94105',
          countryCode: 'US',
        },
        customerEmail: 'reconciliation@example.test',
        pricingFingerprint: preview.pricingFingerprint,
        paymentMethodReference: 'stub-success',
      },
      'recon-checkout-request',
    );
    const group = await prisma.fulfillmentGroup.findFirstOrThrow({
      where: { orderId: confirmed.orderId },
    });
    const fulfillmentActorId = randomUUID();
    await prisma.user.create({
      data: {
        id: fulfillmentActorId,
        emailNormalized: `${fulfillmentActorId}@example.test`,
        passwordHash: 'integration-only',
        status: 'ACTIVE',
        verifiedAt: new Date(),
        userRoles: { create: { role: RoleName.FULFILLER } },
      },
    });
    const groupBalance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { warehouseId: group.warehouseId, variantId },
    });
    const warehouseCode = (
      await prisma.warehouse.findUniqueOrThrow({ where: { id: group.warehouseId } })
    ).code;
    const beforeShipment = await service.reconciliation(actor, {
      pageSize: 100,
      warehouseCode,
      sku: (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).sku,
    });
    const beforeItem = beforeShipment.items.find((entry) => entry.actual.id === groupBalance.id);
    expect(beforeItem).toMatchObject({
      mismatch: false,
      actual: { allocated: groupBalance.allocated },
      ledger: { allocated: groupBalance.allocated },
      business: { allocated: 1 },
    });
    const fulfillmentContext = (suffix: string) => ({
      requestId: `recon-fulfillment-${suffix}-${randomUUID()}`,
      correlationId: `recon-fulfillment-${suffix}-${randomUUID()}`,
      idempotencyKey: `recon-fulfillment-key-${suffix}-${randomUUID()}`,
      actor: { type: 'staff' as const, id: fulfillmentActorId, roles: [RoleName.FULFILLER] },
      reason: `Reconciliation ${suffix}`,
    });
    await fulfillment.transition(
      {
        fulfillmentGroupId: group.id,
        expectedVersion: 1,
        idempotencyKey: `recon-pick-${randomUUID()}`,
        targetStatus: FulfillmentGroupStatus.PICKING,
        reason: 'Reconciliation picking',
      },
      fulfillmentContext('picking'),
    );
    await fulfillment.transition(
      {
        fulfillmentGroupId: group.id,
        expectedVersion: 2,
        idempotencyKey: `recon-pack-${randomUUID()}`,
        targetStatus: FulfillmentGroupStatus.PACKED,
        reason: 'Reconciliation packing',
      },
      fulfillmentContext('packed'),
    );
    await fulfillment.transition(
      {
        fulfillmentGroupId: group.id,
        expectedVersion: 3,
        idempotencyKey: `recon-ship-${randomUUID()}`,
        targetStatus: FulfillmentGroupStatus.SHIPPED,
        reason: 'Reconciliation shipment',
        carrierCode: 'UPS',
        trackingReference: 'RECON123456',
      },
      fulfillmentContext('shipped'),
    );
    const afterBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { id: groupBalance.id },
    });
    const report = await service.reconciliation(actor, {
      pageSize: 100,
      sku: (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).sku,
      warehouseCode,
    });
    const item = report.items.find((entry) => entry.actual.id === groupBalance.id);
    expect(item).toMatchObject({
      mismatch: false,
      actual: {
        onHand: afterBalance.onHand,
        reserved: afterBalance.reserved,
        allocated: 0,
        damaged: afterBalance.damaged,
      },
      ledger: {
        onHand: afterBalance.onHand,
        reserved: afterBalance.reserved,
        allocated: 0,
        damaged: afterBalance.damaged,
      },
      business: { allocated: 0 },
    });
  });

  it('allows exactly one winner when checkout and transfer dispatch race for the final unit', async () => {
    const priceBookVersion = await prisma.priceBookVersion.findFirstOrThrow({
      where: {
        version: 1,
        lifecycle: 'ACTIVE',
        priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
      },
    });
    const activePolicy = await prisma.commercePolicyVersion.findFirst({
      where: { lifecycle: CommercePolicyLifecycle.ACTIVE, countryCode: 'US', currencyCode: 'USD' },
    });
    if (!activePolicy)
      await prisma.commercePolicyVersion.create({
        data: {
          id: randomUUID(),
          version: 1,
          lifecycle: CommercePolicyLifecycle.ACTIVE,
          effectiveFrom: new Date(),
          countryCode: 'US',
          currencyCode: 'USD',
          priceBookVersionId: priceBookVersion.id,
          shippingBaseMinor: 800,
          freeShippingThresholdMinor: 12000,
          heavySurchargeMinor: 400,
          heavyThresholdGrams: 2000,
          taxRateBasisPoints: 825,
          reservationDurationSeconds: 600,
          calculationVersion: `race-${randomUUID()}`,
        },
      });
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const otherBalances = await prisma.inventoryBalance.findMany({
      where: { variantId, warehouseId: { not: sourceWarehouseId } },
    });
    for (const other of otherBalances) {
      const delta = other.reserved + other.allocated + other.damaged - other.onHand;
      if (delta !== 0)
        await service.adjust(
          other.id,
          Object.assign(new InventoryAdjustmentDto(), {
            onHandDelta: delta,
            damagedDelta: 0,
            reason: 'Drain competing policy warehouse',
          }),
          other.version,
          actor,
          `drain-other-${randomUUID()}`,
          'integration-race-drain-other',
        );
    }
    const targetOnHand = balance.reserved + balance.allocated + balance.damaged + 1;
    const drain = targetOnHand - balance.onHand;
    if (drain !== 0)
      await service.adjust(
        balanceId,
        Object.assign(new InventoryAdjustmentDto(), {
          onHandDelta: drain,
          damagedDelta: 0,
          reason: 'Drain to final transferable unit',
        }),
        balance.version,
        actor,
        `drain-${randomUUID()}`,
        'integration-race-drain',
      );
    const current = await carts.getCurrent(undefined);
    const cart = await carts.setItem(current.token, variantId, 1, current.cart.revision);
    const preview = await checkout.preview(cart.token, cart.revision, {
      shippingAddress: {
        fullName: 'Race Buyer',
        line1: '1 Main Street',
        line2: '',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94105',
        countryCode: 'US',
      },
    });
    const created = await service.createTransfer(
      Object.assign(new CreateInventoryTransferDto(), {
        sourceWarehouseId,
        destinationWarehouseId,
        lines: [{ variantId, quantity: 1 }],
        reason: 'Race dispatch',
      }),
      actor,
      `race-transfer-${randomUUID()}`,
      'integration-race-transfer',
    );
    const transferId = (created as { transfer: { id: string } }).transfer.id;
    const checkoutPromise = checkout.create(
      cart.token,
      cart.revision,
      `race-checkout-${randomUUID()}`,
      {
        shippingAddress: {
          fullName: 'Race Buyer',
          line1: '1 Main Street',
          line2: '',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94105',
          countryCode: 'US',
        },
        customerEmail: 'race@example.test',
        pricingFingerprint: preview.pricingFingerprint,
        paymentMethodReference: 'stub-success',
      },
      'integration-race-checkout',
    );
    const dispatchPromise = service.transition(
      transferId,
      Object.assign(new InventoryTransferTransitionDto(), {
        targetStatus: 'IN_TRANSIT',
        reason: 'Race dispatch',
      }),
      1,
      actor,
      `race-dispatch-${randomUUID()}`,
      'integration-race-dispatch',
    );
    const [checkoutResult, dispatchResult] = await Promise.allSettled([
      checkoutPromise,
      dispatchPromise,
    ]);
    const checkoutWon =
      checkoutResult.status === 'fulfilled' && checkoutResult.value.checkoutStatus === 'confirmed';
    const dispatchWon = dispatchResult.status === 'fulfilled';
    expect(checkoutWon || dispatchWon).toBe(true);
    expect(Number(checkoutWon) + Number(dispatchWon)).toBe(1);
    if (!checkoutWon && checkoutResult.status === 'rejected')
      expect(checkoutResult.reason).toBeInstanceOf(CheckoutConflictError);
    if (!dispatchWon && dispatchResult.status === 'rejected')
      expect(dispatchResult.reason).toBeInstanceOf(InventoryOperationConflict);
    const transfer = await prisma.inventoryTransfer.findUniqueOrThrow({
      where: { id: transferId },
    });
    const transferMovements = await prisma.inventoryMovement.count({
      where: { commandId: transferId },
    });
    expect(transferMovements).toBe(dispatchWon ? 1 : 0);
    expect(transfer.status).toBe(dispatchWon ? 'IN_TRANSIT' : 'REQUESTED');
    const finalBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(
      finalBalance.onHand - finalBalance.reserved - finalBalance.allocated - finalBalance.damaged,
    ).toBeGreaterThanOrEqual(0);
  });

  it('returns page-scoped reconciliation without repairing a deliberately corrupted balance', async () => {
    const clean = await service.reconciliation(actor, { pageSize: 1 });
    expect(clean.pageScoped).toBe(true);
    const before = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    await prisma.$executeRawUnsafe(`ALTER TABLE "InventoryBalance" DISABLE TRIGGER USER`);
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "InventoryBalance" SET "onHand" = "onHand" + 7 WHERE "id" = '${balanceId}'`,
      );
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "InventoryBalance" ENABLE TRIGGER USER`);
    }
    const report = await service.reconciliation(actor, {
      pageSize: 100,
      warehouseCode: (
        await prisma.warehouse.findUniqueOrThrow({ where: { id: sourceWarehouseId } })
      ).code,
    });
    const item = report.items.find((entry) => entry.balanceId === balanceId);
    expect(item?.mismatchCategories).toContain('LEDGER_ON_HAND');
    expect(
      await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } }),
    ).toMatchObject({ onHand: before.onHand + 7 });
  });

  it('reports per-line transfer coverage when compensating dispatch errors preserve cumulative sums', async () => {
    const makeTransfer = async (quantity: number, suffix: string) => {
      const created = await service.createTransfer(
        Object.assign(new CreateInventoryTransferDto(), {
          sourceWarehouseId,
          destinationWarehouseId,
          lines: [{ variantId, quantity }],
          reason: `Coverage transfer ${suffix}`,
        }),
        actor,
        `coverage-create-${suffix}-${randomUUID()}`,
        `coverage-create-${suffix}`,
      );
      const id = (created as { transfer: { id: string } }).transfer.id;
      await service.transition(
        id,
        Object.assign(new InventoryTransferTransitionDto(), {
          targetStatus: 'IN_TRANSIT',
          reason: `Coverage dispatch ${suffix}`,
        }),
        1,
        actor,
        `coverage-dispatch-${suffix}-${randomUUID()}`,
        `coverage-dispatch-${suffix}`,
      );
      return id;
    };
    const firstTransferId = await makeTransfer(1, 'one');
    const secondTransferId = await makeTransfer(3, 'three');
    await prisma.$executeRawUnsafe('ALTER TABLE "InventoryMovement" DISABLE TRIGGER USER');
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "InventoryMovement" SET "onHandDelta" = -2 WHERE "commandId" IN ('${firstTransferId}', '${secondTransferId}')`,
      );
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "InventoryMovement" ENABLE TRIGGER USER');
    }
    const report = await service.reconciliation(actor, {
      pageSize: 100,
      warehouseCode: (
        await prisma.warehouse.findUniqueOrThrow({ where: { id: sourceWarehouseId } })
      ).code,
      sku: (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).sku,
    });
    const item = report.items.find((entry) => entry.balanceId === balanceId);
    expect(item?.transfer.movementCoverage.invalidLineCount).toBeGreaterThanOrEqual(2);
    expect(item?.mismatchCategories).toContain('TRANSFER_MOVEMENT_COVERAGE');
    expect(item?.transfer.actual.dispatched).toBe(item?.transfer.expected.outbound);
  });
});
