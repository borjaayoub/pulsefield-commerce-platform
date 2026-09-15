import { createHash, randomUUID } from 'node:crypto';
import { seedPhase3Commerce } from '../../prisma/seed-commerce';
import { AuditService } from '../audit/audit.service';
import { CartService } from '../cart/cart.service';
import { PrismaService } from '../database/prisma.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { IdempotencyConflictError } from '../idempotency/idempotency.errors';
import {
  AuditActorType,
  CartStatus,
  CommercePolicyLifecycle,
  InventoryMovementType,
  NotificationDeliveryType,
  OrderStatus,
  PaymentAttemptStatus,
  ReservationStatus,
  WarehouseStatus,
} from '../generated/prisma/enums';
import { CheckoutService, isRetryableTransactionError } from './checkout.service';
import { CheckoutConflictError } from './checkout.errors';
import { StubPaymentProvider } from '../payments/stub-payment.provider';
import { OrderTimelineService } from '../orders/order-timeline.service';
import { digestGuestOrderAccessToken } from '../orders/guest-order-access';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

const POLICY_ID = '62000000-0000-4000-8000-000000000001';
const VARIANT_ID = '30000000-0000-4000-8000-000000000001';
const ADDRESS = {
  fullName: 'Guest Buyer',
  line1: '100 Market Street',
  line2: '',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94105',
  countryCode: 'US' as const,
};

describe('checkout, reservation, and payment database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const carts = new CartService(prisma);
  const idempotency = new IdempotencyService(prisma);
  const audit = new AuditService();
  const payments = new StubPaymentProvider();
  const orderTimeline = new OrderTimelineService(prisma, Buffer.alloc(32, 8).toString('base64'));
  const checkout = new CheckoutService(prisma, idempotency, audit, payments, orderTimeline);

  beforeEach(async () => {
    await clearCommerceData(prisma);
    await seedPhase3Commerce(prisma);
    await createActivePolicy(prisma);
  });

  afterAll(async () => {
    await clearCommerceData(prisma);
    await prisma.$disconnect();
  });

  it('persists policy and price-book snapshots, commits success, and replays identically', async () => {
    const prepared = await prepareCart();
    const request = checkoutRequest(prepared, 'stub-success');

    const first = await checkout.create(
      prepared.token,
      prepared.revision,
      'checkout-success-replay-001',
      request,
      'req-checkout-success-001',
    );
    const replay = await checkout.create(
      prepared.token,
      prepared.revision,
      'checkout-success-replay-001',
      request,
      'req-checkout-success-002',
    );

    expect(first).toMatchObject({
      checkoutStatus: 'confirmed',
      orderStatus: 'confirmed',
      paymentStatus: 'succeeded',
      reservationStatus: 'committed',
      fulfillmentStatus: 'allocated',
    });
    expect(replay.guestOrderAccessToken).toBe(first.guestOrderAccessToken);
    await expect(
      prisma.guestOrderAccessGrant.findUniqueOrThrow({ where: { orderId: first.orderId } }),
    ).resolves.toMatchObject({
      tokenDigest: digestGuestOrderAccessToken(first.guestOrderAccessToken),
      revokedAt: null,
    });
    expect(replay).toEqual(first);
    await expect(
      checkout.create(
        prepared.token,
        prepared.revision,
        'checkout-success-replay-001',
        checkoutRequest(prepared, 'stub-decline'),
        'req-checkout-success-003',
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: first.orderId },
      include: { lines: true, reservation: true, paymentAttempts: true },
    });
    expect(order.priceBookVersionId).toBe('61000000-0000-4000-8000-000000000001');
    expect(order.customerEmailNormalized).toBe('checkout@example.test');
    expect(order.policyVersionId).toBe(POLICY_ID);
    expect(order.lines[0]).toMatchObject({
      variantId: VARIANT_ID,
      variantNameSnapshot: 'Aero Tempo Tee — S',
      mediaSnapshot: [{ storageKey: 'catalog/seed/aero-tempo-tee.svg' }],
    });
    expect(order.calculationSnapshot).toMatchObject({
      policyId: POLICY_ID,
      priceBookVersionId: order.priceBookVersionId,
      rounding: 'half-up-per-line',
      taxRateBasisPoints: 825,
      shippingBaseMinor: 800,
      reservationDurationSeconds: 600,
    });
    await expect(
      prisma.order.update({
        where: { id: order.id },
        data: { customerEmailNormalized: 'changed@example.test' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.outboxMessage.count({
        where: { aggregateId: order.id, eventType: 'commerce.order.confirmed' },
      }),
    ).resolves.toBe(1);
    const deliveryEventId = randomUUID();
    await expect(
      prisma.notificationDelivery.create({
        data: {
          sourceEventId: deliveryEventId,
          orderId: order.id,
          type: NotificationDeliveryType.ORDER_CONFIRMATION,
          correlationId: 'checkout-order-confirmation-ledger',
        },
      }),
    ).resolves.toMatchObject({ orderId: order.id, userId: null });
    await expect(
      prisma.notificationDelivery.create({
        data: {
          sourceEventId: randomUUID(),
          type: NotificationDeliveryType.ORDER_CONFIRMATION,
          correlationId: 'missing-delivery-owner',
        },
      }),
    ).rejects.toThrow();
    const fulfillmentItem = await prisma.fulfillmentGroupItem.findFirstOrThrow({
      where: { fulfillmentGroup: { orderId: first.orderId } },
    });
    expect(fulfillmentItem.orderLineId).toBe(order.lines[0]?.id);
    await expect(
      prisma.fulfillmentGroupItem.update({
        where: { id: fulfillmentItem.id },
        data: { quantity: fulfillmentItem.quantity + 1 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.fulfillmentGroupItem.delete({ where: { id: fulfillmentItem.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.orderLine.create({
        data: {
          orderId: order.id,
          variantId: VARIANT_ID,
          productNameSnapshot: 'Duplicate line',
          variantNameSnapshot: 'Duplicate variant',
          skuSnapshot: 'duplicate-sku',
          optionValuesSnapshot: {},
          taxClassSnapshot: 'standard',
          weightGramsSnapshot: 0,
          mediaSnapshot: [],
          quantity: 1,
          unitPriceMinor: 0,
          lineSubtotalMinor: 0,
          lineTaxMinor: 0,
          lineTotalMinor: 0,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.cart.findUniqueOrThrow({ where: { id: order.cartId }, include: { items: true } }),
    ).resolves.toMatchObject({ status: CartStatus.CONVERTED, items: [] });
    const freshCart = await carts.getCurrent(prepared.token);
    expect(freshCart).toMatchObject({ createdCookie: true, cart: { revision: 1, items: [] } });
    expect(freshCart.token).not.toBe(prepared.token);

    await prisma.cart.update({
      where: { id: order.cartId },
      data: {
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        expiresAt: new Date('2020-01-02T00:00:00.000Z'),
        absoluteExpiresAt: new Date('2020-01-03T00:00:00.000Z'),
      },
    });
    const abandoned = await prisma.cart.create({
      data: {
        tokenDigest: digest('retention-unrelated-cart'),
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        expiresAt: new Date('2020-01-02T00:00:00.000Z'),
        absoluteExpiresAt: new Date('2020-01-03T00:00:00.000Z'),
      },
    });
    await expect(carts.sweepExpired(500)).resolves.toBe(1);
    await expect(prisma.cart.findUnique({ where: { id: order.cartId } })).resolves.toBeTruthy();
    await expect(prisma.cart.findUnique({ where: { id: abandoned.id } })).resolves.toBeNull();
    await expect(
      prisma.inventoryMovement.count({
        where: {
          commandId: order.reservationId,
          type: InventoryMovementType.RESERVATION_COMMITTED,
        },
      }),
    ).resolves.toBe(1);
  });

  it('preserves the cart on decline and releases the reservation exactly once', async () => {
    const prepared = await prepareCart();
    const request = checkoutRequest(prepared, 'stub-decline');
    const first = await checkout.create(
      prepared.token,
      prepared.revision,
      'checkout-decline-replay-001',
      request,
      'req-checkout-decline-001',
    );
    const replay = await checkout.create(
      prepared.token,
      prepared.revision,
      'checkout-decline-replay-001',
      request,
      'req-checkout-decline-002',
    );

    expect(first).toMatchObject({
      checkoutStatus: 'payment_failed',
      orderStatus: 'pending_payment',
      paymentStatus: 'failed',
      reservationStatus: 'released',
      fulfillmentStatus: null,
    });
    expect(replay).toEqual(first);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: first.orderId } });
    const cart = await prisma.cart.findUniqueOrThrow({
      where: { id: order.cartId },
      include: { items: true },
    });
    expect(cart).toMatchObject({
      status: CartStatus.OPEN,
      items: [{ variantId: VARIANT_ID, quantity: 1 }],
    });
    expect(cart.revision).toBeGreaterThan(prepared.revision);
    await expect(
      prisma.inventoryMovement.count({
        where: {
          commandId: order.reservationId,
          type: InventoryMovementType.RESERVATION_RELEASED,
        },
      }),
    ).resolves.toBe(1);
  });

  it('protects active policy history and rejects inconsistent payment transitions', async () => {
    const policy = await prisma.commercePolicyVersion.findUniqueOrThrow({
      where: { id: POLICY_ID },
    });
    await expect(
      prisma.commercePolicyVersion.update({
        where: { id: policy.id },
        data: { shippingBaseMinor: policy.shippingBaseMinor + 1 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.commercePolicyVersion.delete({ where: { id: policy.id } }),
    ).rejects.toThrow();
    const priceBookVersion = await prisma.priceBookVersion.findUniqueOrThrow({
      where: { id: policy.priceBookVersionId },
    });
    await expect(
      prisma.commercePolicyVersion.create({
        data: {
          id: randomUUID(),
          version: 2,
          lifecycle: CommercePolicyLifecycle.DRAFT,
          countryCode: 'US',
          currencyCode: 'USD',
          priceBookVersionId: priceBookVersion.id,
          shippingBaseMinor: 800,
          freeShippingThresholdMinor: 12_000,
          heavySurchargeMinor: 400,
          heavyThresholdGrams: 2_000,
          taxRateBasisPoints: 10_001,
          reservationDurationSeconds: 600,
          calculationVersion: 'invalid-tax-bound',
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.commercePolicyVersion.create({
        data: {
          id: randomUUID(),
          version: 3,
          lifecycle: CommercePolicyLifecycle.DRAFT,
          countryCode: 'US',
          currencyCode: 'USD',
          priceBookVersionId: priceBookVersion.id,
          shippingBaseMinor: 800,
          freeShippingThresholdMinor: 12_000,
          heavySurchargeMinor: 400,
          heavyThresholdGrams: 2_000,
          taxRateBasisPoints: 825,
          reservationDurationSeconds: 86_401,
          calculationVersion: 'invalid-duration-bound',
        },
      }),
    ).rejects.toThrow();

    const prepared = await prepareCart();
    const cartId = await prisma.cart.findUniqueOrThrow({
      where: { tokenDigest: digest(prepared.token) },
      select: { id: true },
    });
    await expect(
      prisma.cart.update({ where: { id: cartId.id }, data: { status: CartStatus.CONVERTED } }),
    ).rejects.toThrow();

    const processingCheckout = new CheckoutService(prisma, idempotency, audit, {
      async createPayment() {
        return { paymentId: `processing_${randomUUID()}`, status: 'processing' as const };
      },
    });
    const pending = await processingCheckout.create(
      prepared.token,
      prepared.revision,
      'checkout-processing-001',
      checkoutRequest(prepared, 'stub-success'),
      'req-checkout-processing-001',
    );
    const pendingOrder = await prisma.order.findUniqueOrThrow({
      where: { id: pending.orderId },
      select: { reservationId: true },
    });
    await expect(
      prisma.inventoryReservation.update({
        where: { id: pendingOrder.reservationId },
        data: { status: ReservationStatus.COMMITTED },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.order.update({
        where: { id: pending.orderId },
        data: { status: OrderStatus.CONFIRMED },
      }),
    ).rejects.toThrow();
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { orderId: pending.orderId },
    });
    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: PaymentAttemptStatus.SUCCEEDED, providerPaymentId: 'tampered-success' },
      }),
    ).rejects.toThrow();
  });

  it('serializes fifty competing attempts against constrained stock without overselling', async () => {
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { variantId: VARIANT_ID },
    });
    const constrainedOnHand = 3;
    await prisma.inventoryBalance.update({
      where: { id: balance.id },
      data: { onHand: constrainedOnHand, version: { increment: 1 } },
    });
    await prisma.inventoryMovement.create({
      data: {
        warehouseId: balance.warehouseId,
        variantId: balance.variantId,
        type: InventoryMovementType.ADJUSTMENT,
        onHandDelta: constrainedOnHand - balance.onHand,
        resultingOnHand: constrainedOnHand,
        resultingReserved: balance.reserved,
        resultingAllocated: balance.allocated,
        resultingDamaged: balance.damaged,
        commandId: randomUUID(),
        commandSequence: 1,
        actorType: AuditActorType.SYSTEM,
        actorId: 'system:checkout-integration',
        reason: 'Constrain stock for checkout contention test.',
      },
    });

    const prepared = await Promise.all(Array.from({ length: 50 }, () => prepareCart()));
    const attempts = await Promise.allSettled(
      prepared.map((cart, index) =>
        checkout.create(
          cart.token,
          cart.revision,
          `checkout-race-${index.toString().padStart(2, '0')}-001`,
          checkoutRequest(cart, 'stub-success'),
          `req-checkout-race-${index.toString().padStart(2, '0')}`,
        ),
      ),
    );
    const succeeded = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<Awaited<ReturnType<CheckoutService['create']>>> =>
        attempt.status === 'fulfilled' && attempt.value.checkoutStatus === 'confirmed',
    );
    expect(succeeded).toHaveLength(constrainedOnHand);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(
      constrainedOnHand,
    );
    const unsuccessful = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(unsuccessful).toHaveLength(50 - constrainedOnHand);
    expect(
      unsuccessful.every(
        (attempt) =>
          attempt.status === 'rejected' &&
          ((attempt.reason instanceof CheckoutConflictError &&
            attempt.reason.code === 'INSUFFICIENT_STOCK') ||
            isRetryableTransactionError(attempt.reason)),
      ),
    ).toBe(true);

    const finalBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { id: balance.id },
    });
    expect(
      finalBalance.onHand - finalBalance.reserved - finalBalance.allocated - finalBalance.damaged,
    ).toBe(0);
    expect(finalBalance.reserved).toBe(0);
    expect(finalBalance.allocated).toBe(constrainedOnHand);
    expect(finalBalance.onHand).toBe(constrainedOnHand);
    expect(finalBalance.reserved).toBeGreaterThanOrEqual(0);
    expect(finalBalance.allocated).toBeGreaterThanOrEqual(0);
    const movementTotals = await prisma.inventoryMovement.aggregate({
      where: { warehouseId: balance.warehouseId, variantId: balance.variantId },
      _sum: { onHandDelta: true, reservedDelta: true, allocatedDelta: true, damagedDelta: true },
    });
    expect(movementTotals._sum.onHandDelta).toBe(finalBalance.onHand);
    expect(movementTotals._sum.reservedDelta).toBe(finalBalance.reserved);
    expect(movementTotals._sum.allocatedDelta).toBe(finalBalance.allocated);
    expect(movementTotals._sum.damagedDelta).toBe(finalBalance.damaged);
  });

  it('uses the deterministic US-EAST-01 warehouse without cross-warehouse aggregation', async () => {
    const primary = await prisma.inventoryBalance.findFirstOrThrow({
      where: { variantId: VARIANT_ID },
    });
    const primaryOnHand = 1;
    await prisma.inventoryBalance.update({
      where: { id: primary.id },
      data: { onHand: primaryOnHand, version: { increment: 1 } },
    });
    await prisma.inventoryMovement.create({
      data: {
        warehouseId: primary.warehouseId,
        variantId: primary.variantId,
        type: InventoryMovementType.ADJUSTMENT,
        onHandDelta: primaryOnHand - primary.onHand,
        resultingOnHand: primaryOnHand,
        resultingReserved: primary.reserved,
        resultingAllocated: primary.allocated,
        resultingDamaged: primary.damaged,
        commandId: randomUUID(),
        commandSequence: 1,
        actorType: AuditActorType.SYSTEM,
        actorId: 'system:checkout-integration',
        reason: 'Constrain the deterministic checkout warehouse.',
      },
    });
    const secondary = await prisma.warehouse.create({
      data: {
        id: randomUUID(),
        code: 'US-WEST-02',
        name: 'US West 02',
        countryCode: 'US',
        status: WarehouseStatus.ACTIVE,
      },
    });
    const secondaryOnHand = 9;
    await prisma.inventoryBalance.create({
      data: {
        warehouseId: secondary.id,
        variantId: VARIANT_ID,
        onHand: secondaryOnHand,
      },
    });
    await prisma.inventoryMovement.create({
      data: {
        warehouseId: secondary.id,
        variantId: VARIANT_ID,
        type: InventoryMovementType.ADJUSTMENT,
        onHandDelta: secondaryOnHand,
        resultingOnHand: secondaryOnHand,
        resultingReserved: 0,
        resultingAllocated: 0,
        resultingDamaged: 0,
        commandId: randomUUID(),
        commandSequence: 1,
        actorType: AuditActorType.SYSTEM,
        actorId: 'system:checkout-integration',
        reason: 'Add stock to a non-checkout warehouse.',
      },
    });

    const current = await carts.getCurrent(undefined);
    const updated = await carts.setItem(current.token, VARIANT_ID, 2, current.cart.revision);
    expect(updated.cart.items[0]).toMatchObject({ available: primaryOnHand + secondaryOnHand });
    await expect(
      checkout.preview(updated.token, updated.revision, { shippingAddress: ADDRESS }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await expect(prisma.inventoryReservation.count()).resolves.toBe(0);
    await expect(prisma.order.count()).resolves.toBe(0);
  });

  async function prepareCart(): Promise<PreparedCart> {
    const current = await carts.getCurrent(undefined);
    const updated = await carts.setItem(current.token, VARIANT_ID, 1, current.cart.revision);
    const preview = await checkout.preview(updated.token, updated.revision, {
      shippingAddress: ADDRESS,
    });
    return {
      token: updated.token,
      revision: updated.revision,
      pricingFingerprint: preview.pricingFingerprint,
    };
  }
});

interface PreparedCart {
  token: string;
  revision: number;
  pricingFingerprint: string;
}

function checkoutRequest(
  prepared: PreparedCart,
  paymentMethodReference: 'stub-success' | 'stub-decline',
) {
  return {
    shippingAddress: ADDRESS,
    customerEmail: 'checkout@example.test',
    pricingFingerprint: prepared.pricingFingerprint,
    paymentMethodReference,
  };
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function createActivePolicy(prisma: PrismaService): Promise<void> {
  const priceBookVersion = await prisma.priceBookVersion.findFirstOrThrow({
    where: {
      version: 1,
      lifecycle: 'ACTIVE',
      priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
    },
  });
  await prisma.commercePolicyVersion.create({
    data: {
      id: POLICY_ID,
      version: 1,
      lifecycle: CommercePolicyLifecycle.ACTIVE,
      effectiveFrom: new Date('2026-09-10T00:00:00.000Z'),
      countryCode: 'US',
      currencyCode: 'USD',
      priceBookVersionId: priceBookVersion.id,
      shippingBaseMinor: 800,
      freeShippingThresholdMinor: 12_000,
      heavySurchargeMinor: 400,
      heavyThresholdGrams: 2_000,
      taxRateBasisPoints: 825,
      reservationDurationSeconds: 600,
      calculationVersion: 'us-usd-2026-09-10',
    },
  });
}

async function clearCommerceData(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "FulfillmentGroupItem",
      "FulfillmentGroup",
      "PaymentAttempt",
      "OrderLine",
      "Order",
      "InventoryReservationItem",
      "InventoryReservation",
      "CartItem",
      "Cart",
      "CommercePolicyVersion",
      "InventoryMovement",
      "InventoryBalance",
      "Warehouse",
      "VariantPrice",
      "PriceBookVersion",
      "PriceBook",
      "ProductMedia",
      "ProductCategory",
      "Category",
      "ProductVariant",
      "ProductSlug",
      "Product"
    CASCADE
  `);
}
