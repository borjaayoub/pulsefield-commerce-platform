import { randomUUID } from 'node:crypto';
import { seedInternationalCommerce } from '../../prisma/seed-international-commerce';
import { setUsShoppingReservationDuration } from '../testing/shopping-fixtures';
import { seedPhase3Commerce } from '../../prisma/seed-commerce';
import { AuditService } from '../audit/audit.service';
import { CartService } from '../cart/cart.service';
import {
  CheckoutService,
  isRetryableTransactionError,
  withCheckoutTransactionRetry,
} from '../checkout/checkout.service';
import { CheckoutConflictError } from '../checkout/checkout.errors';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { FulfillmentGroupStatus, RoleName } from '../generated/prisma/enums';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { OrderTimelineService } from '../orders/order-timeline.service';
import {
  PaymentOutcomeService,
  PaymentOutcomeConflictError,
} from '../payments/payment-outcome.service';
import { StubPaymentProvider } from '../payments/stub-payment.provider';
import { ReservationExpiryService } from '../reservation-expiry/reservation-expiry.service';
import {
  appendRealtimeInvalidation,
  INVENTORY_INVALIDATED_EVENT,
} from '../realtime/realtime.events';
import { resolveIntegrationDatabaseUrl } from '../testing/integration-database-url';
import { InventoryOperationsService } from './inventory-operations.service';
import {
  InventoryAdjustmentDto,
  CreateInventoryTransferDto,
  InventoryTransferTransitionDto,
} from './inventory-operations.dto';
import { InventoryOperationConflict } from './inventory-operations.errors';

if (!process.env.DATABASE_URL || !process.env.TEST_DATABASE_URL) {
  throw new Error('Use the guarded test:phase5 or test:integration runner.');
}
const databaseUrl = resolveIntegrationDatabaseUrl(
  process.env.DATABASE_URL,
  process.env.TEST_DATABASE_URL,
);
const ADDRESS = {
  fullName: 'Acceptance buyer',
  line1: '1 Market Street',
  line2: '',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94105',
  countryCode: 'US' as const,
};
const ACTOR_ID = 'abababab-abab-4bab-8bab-abababababab';
const FULFILLER_ID = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const actor = { id: ACTOR_ID, roles: [RoleName.ADMINISTRATOR] };

describe('Phase 5 cross-workflow concurrency acceptance', () => {
  // Independent pools prove contention is coordinated by PostgreSQL, not one client.
  // This is not claimed as a multiple-API-process rehearsal.
  const clients = [new PrismaService(databaseUrl), new PrismaService(databaseUrl)];
  const prisma = clients[0];
  const audit = new AuditService();
  const inventory = clients.map(
    (client) =>
      new InventoryOperationsService(
        client,
        new IdempotencyService(client),
        audit,
        Buffer.alloc(32, 7).toString('base64'),
      ),
  );
  const carts = new CartService(prisma);
  const checkouts = clients.map(
    (client) =>
      new CheckoutService(
        client,
        new IdempotencyService(client),
        audit,
        new StubPaymentProvider(),
        new OrderTimelineService(client, Buffer.alloc(32, 8).toString('base64')),
      ),
  );
  const fulfillment = new FulfillmentService(prisma, new IdempotencyService(prisma), audit);
  let variantId: string;
  let sourceId: string;
  let destinationId: string;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "InventoryCommandResult", "IdempotencyRecord",
      "AuditRecord", "OutboxMessage", "InventoryTransfer", "Order", "InventoryReservation",
      "Cart", "CommercePolicyVersion", "InventoryMovement", "InventoryBalance",
      "InventoryAllocationPolicy", "Warehouse", "PriceBook", "Product", "Category" CASCADE`);
    await seedPhase3Commerce(prisma);
    await seedInternationalCommerce(prisma);
    variantId = (await prisma.productVariant.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;
    sourceId = (await prisma.warehouse.findUniqueOrThrow({ where: { code: 'US-EAST-01' } })).id;
    destinationId = (await prisma.warehouse.findUniqueOrThrow({ where: { code: 'EU-CENTRAL-01' } }))
      .id;
    await prisma.user.upsert({
      where: { id: ACTOR_ID },
      update: { status: 'ACTIVE', verifiedAt: new Date() },
      create: {
        id: ACTOR_ID,
        emailNormalized: 'phase5-acceptance@example.test',
        passwordHash: 'integration-only',
        status: 'ACTIVE',
        verifiedAt: new Date(),
        userRoles: { create: { role: RoleName.ADMINISTRATOR } },
      },
    });
    await prisma.user.upsert({
      where: { id: FULFILLER_ID },
      update: { status: 'ACTIVE', verifiedAt: new Date() },
      create: {
        id: FULFILLER_ID,
        emailNormalized: 'phase5-fulfiller@example.test',
        passwordHash: 'integration-only',
        status: 'ACTIVE',
        verifiedAt: new Date(),
        userRoles: { create: { role: RoleName.FULFILLER } },
      },
    });
    const price = await prisma.priceBookVersion.findFirstOrThrow({
      where: { lifecycle: 'ACTIVE' },
    });
    await prisma.commercePolicyVersion.create({
      data: {
        id: randomUUID(),
        version: 1,
        lifecycle: 'ACTIVE',
        effectiveFrom: new Date(),
        countryCode: 'US',
        currencyCode: 'USD',
        priceBookVersionId: price.id,
        shippingBaseMinor: 800,
        freeShippingThresholdMinor: 12000,
        heavySurchargeMinor: 400,
        heavyThresholdGrams: 2000,
        taxRateBasisPoints: 825,
        reservationDurationSeconds: 600,
        calculationVersion: 'phase5-acceptance',
      },
    });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
  });

  async function constrain(us: number, eu = 0, ma = 0) {
    for (const balance of await prisma.inventoryBalance.findMany({
      where: { variantId },
      include: { warehouse: true },
    })) {
      const desired =
        balance.warehouse.code === 'US-EAST-01'
          ? us
          : balance.warehouse.code === 'EU-CENTRAL-01'
            ? eu
            : ma;
      if (desired !== balance.onHand)
        await inventory[0].adjust(
          balance.id,
          Object.assign(new InventoryAdjustmentDto(), {
            onHandDelta: desired - balance.onHand,
            damagedDelta: 0,
            reason: 'Constrain acceptance stock',
          }),
          balance.version,
          actor,
          randomUUID(),
          randomUUID(),
        );
    }
  }
  async function prepare(quantity = 1) {
    const current = await carts.getCurrent(undefined);
    const cart = await carts.setItem(current.token, variantId, quantity, current.cart.revision);
    const preview = await checkouts[0].preview(cart.token, cart.revision, {
      shippingAddress: ADDRESS,
    });
    return {
      token: cart.token,
      revision: cart.revision,
      request: {
        shippingAddress: ADDRESS,
        customerEmail: 'acceptance@example.test',
        pricingFingerprint: preview.pricingFingerprint,
        paymentMethodReference: 'stub-success' as const,
      },
      key: randomUUID(),
    };
  }
  function submit(prepared: Awaited<ReturnType<typeof prepare>>, client = 0) {
    return checkouts[client].create(
      prepared.token,
      prepared.revision,
      prepared.key,
      prepared.request,
      randomUUID(),
    );
  }
  async function transfer(quantity: number) {
    const created = await inventory[0].createTransfer(
      Object.assign(new CreateInventoryTransferDto(), {
        sourceWarehouseId: sourceId,
        destinationWarehouseId: destinationId,
        lines: [{ variantId, quantity }],
        reason: 'Acceptance transfer',
      }),
      actor,
      randomUUID(),
      randomUUID(),
    );
    return (created as { transfer: { id: string } }).transfer.id;
  }
  function dispatch(id: string, key = randomUUID()) {
    return inventory[1].transition(
      id,
      Object.assign(new InventoryTransferTransitionDto(), {
        targetStatus: 'IN_TRANSIT',
        reason: 'Acceptance dispatch',
      }),
      1,
      actor,
      key,
      randomUUID(),
    );
  }
  async function sourceBalance() {
    return prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_variantId: { warehouseId: sourceId, variantId } },
    });
  }
  async function assertConservation() {
    const balances = await prisma.inventoryBalance.findMany({ where: { variantId } });
    expect(balances).toHaveLength(3);
    for (const balance of balances) {
      expect(balance.onHand).toBeGreaterThanOrEqual(0);
      expect(balance.reserved).toBeGreaterThanOrEqual(0);
      expect(balance.allocated).toBeGreaterThanOrEqual(0);
      expect(balance.damaged).toBeGreaterThanOrEqual(0);
      expect(balance.reserved + balance.allocated + balance.damaged).toBeLessThanOrEqual(
        balance.onHand,
      );
      const ledger = await prisma.inventoryMovement.aggregate({
        where: { warehouseId: balance.warehouseId, variantId },
        _sum: { onHandDelta: true, reservedDelta: true, allocatedDelta: true, damagedDelta: true },
      });
      expect(ledger._sum).toEqual({
        onHandDelta: balance.onHand,
        reservedDelta: balance.reserved,
        allocatedDelta: balance.allocated,
        damagedDelta: balance.damaged,
      });
    }
    const sku = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).sku;
    const report = await inventory[0].reconciliation(actor, { pageSize: 100, sku });
    expect(report.items).toHaveLength(3);
    expect(report.nextCursor).toBeNull();
    expect(report.clean).toBe(true);
    expect(report.mismatchCount).toBe(0);
  }
  function expectedStockLoss(error: unknown) {
    return (
      (error instanceof CheckoutConflictError && error.code === 'INSUFFICIENT_STOCK') ||
      (error instanceof InventoryOperationConflict &&
        error.message === 'Insufficient source availability.') ||
      isRetryableTransactionError(error)
    );
  }
  function transition(
    groupId: string,
    version: number,
    status: 'PICKING' | 'PACKED' | 'SHIPPED',
    key = randomUUID(),
  ) {
    return fulfillment.transition(
      {
        fulfillmentGroupId: groupId,
        expectedVersion: version,
        idempotencyKey: key,
        targetStatus: status,
        reason: 'Acceptance fulfillment',
        ...(status === 'SHIPPED' ? { carrierCode: 'DHL', trackingReference: 'ACCEPTANCE001' } : {}),
      },
      {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        idempotencyKey: key,
        actor: { type: 'staff', id: FULFILLER_ID, roles: [RoleName.FULFILLER] },
        reason: 'Acceptance fulfillment',
      },
    );
  }

  it('bounds 50 two-unit checkouts across independent pools and exhausts distributed stock safely', async () => {
    await constrain(3, 3);
    const prepared = await Promise.all(Array.from({ length: 50 }, () => prepare(2)));
    const outcomes = await Promise.allSettled(
      prepared.map((cart, index) => submit(cart, index % 2)),
    );
    let successes = outcomes.filter((result) => result.status === 'fulfilled').length;
    expect(successes).toBeLessThanOrEqual(3);
    for (let index = 0; index < outcomes.length; index++) {
      const outcome = outcomes[index];
      if (outcome.status !== 'rejected') continue;
      expect(expectedStockLoss(outcome.reason)).toBe(true);
      if (isRetryableTransactionError(outcome.reason)) {
        // Bounded caller recovery reuses the original cart/key after exhausted retries.
        try {
          await submit(prepared[index], index % 2);
          successes++;
        } catch (error) {
          expect(error).toBeInstanceOf(CheckoutConflictError);
        }
      }
    }
    expect(successes).toBe(3);
    expect(await prisma.order.count({ where: { status: 'CONFIRMED' } })).toBe(3);
    expect(
      await prisma.inventoryReservationItem.aggregate({ _sum: { quantity: true } }),
    ).toMatchObject({ _sum: { quantity: 6 } });
    // Three units per region force one of the two-unit orders to split.
    const groups = await prisma.fulfillmentGroup.findMany();
    expect(groups).toHaveLength(4);
    await assertConservation();
  }, 60000);

  it('gives checkout or transfer dispatch the last unit, then replays the winner without new effects', async () => {
    await constrain(1);
    const prepared = await prepare();
    const transferId = await transfer(1);
    const dispatchKey = randomUUID();
    const outcomes = await Promise.allSettled([
      submit(prepared),
      dispatch(transferId, dispatchKey),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of outcomes)
      if (result.status === 'rejected') expect(expectedStockLoss(result.reason)).toBe(true);
    const before = await effectCounts();
    if (outcomes[0].status === 'fulfilled') {
      expect(await submit(prepared)).toEqual(outcomes[0].value);
      expect(await sourceBalance()).toMatchObject({ onHand: 1, allocated: 1, reserved: 0 });
    } else {
      expect(await dispatch(transferId, dispatchKey)).toEqual(
        (outcomes[1] as PromiseFulfilledResult<unknown>).value,
      );
      expect(await sourceBalance()).toMatchObject({ onHand: 0, allocated: 0, reserved: 0 });
    }
    expect(await effectCounts()).toEqual(before);
    await assertConservation();
  }, 30000);

  it('conserves one balance while checkout, transfer, shipping, payment and expiry contend', async () => {
    await constrain(3);
    const confirmed = await submit(await prepare());
    const group = await prisma.fulfillmentGroup.findFirstOrThrow({
      where: { orderId: confirmed.orderId },
    });
    await transition(group.id, 1, 'PICKING');
    await transition(group.id, 2, 'PACKED');
    // A one-second policy for the pending order avoids rewriting immutable expiry evidence.
    const active = await prisma.commercePolicyVersion.findFirstOrThrow({
      where: { lifecycle: 'ACTIVE' },
    });
    await prisma.commercePolicyVersion.update({
      where: { id: active.id },
      data: { lifecycle: 'RETIRED', effectiveUntil: new Date() },
    });
    await prisma.commercePolicyVersion.create({
      data: {
        ...active,
        id: randomUUID(),
        version: 2,
        lifecycle: 'ACTIVE',
        effectiveFrom: new Date(),
        reservationDurationSeconds: 1,
        calculationVersion: 'phase5-expiry-acceptance',
      },
    });
    await setUsShoppingReservationDuration(prisma, 1);
    const pendingProviderId = randomUUID();
    const pendingCheckout = new CheckoutService(
      prisma,
      new IdempotencyService(prisma),
      audit,
      {
        async createPayment() {
          return { paymentId: pendingProviderId, status: 'processing' as const };
        },
      },
      new OrderTimelineService(prisma, Buffer.alloc(32, 8).toString('base64')),
    );
    const preparedPending = await prepare();
    const pending = await pendingCheckout.create(
      preparedPending.token,
      preparedPending.revision,
      preparedPending.key,
      preparedPending.request,
      randomUUID(),
    );
    const reservation = await prisma.inventoryReservation.findFirstOrThrow({
      where: { order: { id: pending.orderId } },
    });
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { orderId: pending.orderId },
    });
    const fresh = await prepare();
    const transferId = await transfer(1);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, reservation.expiresAt.getTime() - Date.now()) + 100),
    );
    const expiry = new ReservationExpiryService(clients[1], audit);
    const payments = new PaymentOutcomeService(clients[1], audit);
    const shippingKey = randomUUID();
    const outcomes = await Promise.allSettled([
      submit(fresh),
      dispatch(transferId),
      transition(group.id, 3, 'SHIPPED', shippingKey),
      withCheckoutTransactionRetry(() =>
        payments.apply({
          orderId: pending.orderId,
          paymentAttemptId: attempt.id,
          providerPaymentId: pendingProviderId,
          status: 'succeeded',
          requestId: randomUUID(),
        }),
      ),
      expiry.sweepExpired(),
    ]);
    // Inspect every result; unrelated errors must not masquerade as contention.
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'rejected') {
        if (index < 2) expect(expectedStockLoss(outcome.reason)).toBe(true);
        else if (index === 2) {
          expect(isRetryableTransactionError(outcome.reason)).toBe(true);
          // Bounded caller recovery preserves the original command/key.
          await transition(group.id, 3, 'SHIPPED', shippingKey);
        } else if (index === 3) {
          if (!(outcome.reason instanceof PaymentOutcomeConflictError)) throw outcome.reason;
        } else throw outcome.reason;
      }
    }
    expect(
      await prisma.fulfillmentGroup.findUniqueOrThrow({ where: { id: group.id } }),
    ).toMatchObject({ status: 'SHIPPED', version: 4 });
    const terminal = await prisma.inventoryReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(terminal.status).toBe('EXPIRED');
    expect(
      await prisma.inventoryMovement.count({
        where: { commandId: reservation.id, type: 'RESERVATION_EXPIRED' },
      }),
    ).toBe(1);
    expect(
      await prisma.inventoryMovement.count({
        where: { commandId: group.id, type: 'FULFILLMENT_DECREMENT' },
      }),
    ).toBe(1);
    const counts = await effectCounts();
    await transition(group.id, 3, 'SHIPPED', shippingKey);
    expect(await expiry.sweepExpired()).toBe(0);
    expect(await effectCounts()).toEqual(counts);
    await assertConservation();
  }, 30000);

  async function effectCounts() {
    return Promise.all([
      prisma.inventoryMovement.count(),
      prisma.outboxMessage.count(),
      prisma.auditRecord.count(),
      prisma.inventoryCommandResult.count(),
    ]);
  }

  it('rolls back shipping stock and event evidence on audit failure, then retries the same command', async () => {
    await constrain(1);
    const confirmed = await submit(await prepare());
    const group = await prisma.fulfillmentGroup.findFirstOrThrow({
      where: { orderId: confirmed.orderId },
    });
    await transition(group.id, 1, 'PICKING');
    await transition(group.id, 2, 'PACKED');
    const counts = await effectCounts();
    const before = await sourceBalance();
    jest.spyOn(audit, 'append').mockRejectedValueOnce(new Error('acceptance rollback'));
    const key = randomUUID();
    await expect(transition(group.id, 3, 'SHIPPED', key)).rejects.toThrow('acceptance rollback');
    expect(await sourceBalance()).toEqual(before);
    expect(await effectCounts()).toEqual(counts);
    expect(
      await prisma.fulfillmentGroup.findUniqueOrThrow({ where: { id: group.id } }),
    ).toMatchObject({ status: FulfillmentGroupStatus.PACKED, version: 3 });
    await transition(group.id, 3, 'SHIPPED', key);
    const after = await effectCounts();
    await transition(group.id, 3, 'SHIPPED', key);
    expect(await effectCounts()).toEqual(after);
    await assertConservation();
  }, 30000);

  it('discards uncommitted stock, movement and event evidence when its own database connection is terminated', async () => {
    const before = await sourceBalance();
    const counts = await effectCounts();
    let terminated = false;
    await expect(
      prisma.$transaction(async (tx) => {
        const [connection] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        const after = await tx.inventoryBalance.update({
          where: { id: before.id },
          data: { onHand: { increment: 1 }, version: { increment: 1 } },
        });
        await tx.inventoryMovement.create({
          data: {
            warehouseId: sourceId,
            variantId,
            type: 'ADJUSTMENT',
            onHandDelta: 1,
            resultingOnHand: after.onHand,
            resultingReserved: after.reserved,
            resultingAllocated: after.allocated,
            resultingDamaged: after.damaged,
            commandId: randomUUID(),
            commandSequence: 1,
            actorType: 'SYSTEM',
            actorId: 'system:phase5-acceptance',
            reason: 'Interrupted transaction fixture',
          },
        });
        await appendRealtimeInvalidation(tx, {
          type: INVENTORY_INVALIDATED_EVENT,
          aggregateType: 'inventory-balance',
          resourceId: before.id,
          resourceVersion: after.version,
          correlationId: randomUUID(),
        });
        // Terminate only the PID just obtained from this test's own transaction.
        const [result] = await clients[1].$queryRaw<Array<{ terminated: boolean }>>`
        SELECT pg_terminate_backend(${connection.pid}::integer) AS terminated`;
        terminated = result.terminated;
        await tx.$queryRaw`SELECT 1`;
      }),
    ).rejects.toThrow();
    expect(terminated).toBe(true);
    expect(await sourceBalance()).toEqual(before);
    expect(await effectCounts()).toEqual(counts);
    await assertConservation();
  }, 30000);

  it('retries a real PostgreSQL serialization failure without retaining aborted outbox evidence', async () => {
    const before = await sourceBalance();
    const correlationId = randomUUID();
    let attempts = 0;
    const failures: unknown[] = [];
    await withCheckoutTransactionRetry(async () => {
      attempts++;
      try {
        return await prisma.$transaction(
          async (tx) => {
            const snapshot = await tx.inventoryBalance.findUniqueOrThrow({
              where: { id: before.id },
            });
            await appendRealtimeInvalidation(tx, {
              type: INVENTORY_INVALIDATED_EVENT,
              aggregateType: 'inventory-balance',
              resourceId: before.id,
              resourceVersion: snapshot.version + 1,
              correlationId,
            });
            if (attempts === 1)
              await inventory[1].threshold(
                before.id,
                { lowStockThreshold: 2, reason: 'Force serialization conflict' },
                snapshot.version,
                actor,
                randomUUID(),
                randomUUID(),
              );
            await tx.inventoryBalance.update({
              where: { id: before.id },
              data: { lowStockThreshold: 3, version: { increment: 1 } },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        failures.push(error);
        throw error;
      }
    });
    expect(attempts).toBe(2);
    expect(failures).toHaveLength(1);
    expect(isRetryableTransactionError(failures[0])).toBe(true);
    expect(await sourceBalance()).toMatchObject({
      version: before.version + 2,
      lowStockThreshold: 3,
    });
    expect(await prisma.outboxMessage.count({ where: { correlationId } })).toBe(1);
    await assertConservation();
  }, 30000);

  it('retries a real opposite-lock PostgreSQL deadlock within the production retry bound', async () => {
    const rows = await prisma.inventoryBalance.findMany({
      where: { variantId },
      orderBy: { id: 'asc' },
      take: 2,
    });
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts = [0, 0];
    const failures: unknown[] = [];
    await Promise.all(
      clients.map((client, index) =>
        withCheckoutTransactionRetry(async () => {
          attempts[index]++;
          try {
            await client.$transaction(
              async (tx) => {
                const first = rows[index].id;
                const second = rows[1 - index].id;
                await tx.$queryRaw`SELECT "id" FROM "InventoryBalance" WHERE "id" = ${first} FOR UPDATE`;
                if (attempts[index] === 1) {
                  if (++arrived === 2) release();
                  await barrier;
                }
                await tx.$queryRaw`SELECT "id" FROM "InventoryBalance" WHERE "id" = ${second} FOR UPDATE`;
              },
              { timeout: 15000 },
            );
          } catch (error) {
            failures.push(error);
            throw error;
          }
        }),
      ),
    );
    expect(attempts.sort()).toEqual([1, 2]);
    expect(failures).toHaveLength(1);
    expect(isRetryableTransactionError(failures[0])).toBe(true);
    await assertConservation();
  }, 30000);
});
