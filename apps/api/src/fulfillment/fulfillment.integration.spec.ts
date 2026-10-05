import { createHash, randomUUID } from 'node:crypto';
import { seedPhase3Commerce } from '../../prisma/seed-commerce';
import { AuditService } from '../audit/audit.service';
import { CartService } from '../cart/cart.service';
import { CheckoutService } from '../checkout/checkout.service';
import { PrismaService } from '../database/prisma.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { IdempotencyRetentionService } from '../idempotency/idempotency-retention.service';
import { IdempotencyConflictError } from '../idempotency/idempotency.errors';
import {
  AccountStatus,
  AuditActorType,
  CartStatus,
  CommercePolicyLifecycle,
  FulfillmentGroupStatus,
  InventoryMovementType,
  OrderStatus,
  PaymentAttemptStatus,
  ReservationStatus,
  RoleName,
} from '../generated/prisma/enums';
import { StubPaymentProvider } from '../payments/stub-payment.provider';
import { FulfillmentService } from './fulfillment.service';
import { ReservationExpiryService } from '../reservation-expiry/reservation-expiry.service';
import { PaymentApplicationService } from '../payments/payment-application.service';
import {
  PaymentProviderRejectedError,
  PaymentProviderUnavailableError,
} from '../payments/stripe-payment.provider';

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

describe('reservation expiry and staff fulfillment database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const audit = new AuditService();
  const idempotency = new IdempotencyService(prisma);
  const carts = new CartService(prisma);
  const checkout = new CheckoutService(prisma, idempotency, audit, new StubPaymentProvider());
  const fulfillment = new FulfillmentService(prisma, idempotency, audit);
  const users = new Set<string>();

  beforeEach(async () => {
    await clearCommerceData(prisma);
    await seedPhase3Commerce(prisma);
    await createActivePolicy(prisma);
  });

  afterEach(async () => {
    const ids = [...users];
    if (ids.length > 0) {
      await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    users.clear();
  });

  afterAll(async () => {
    await clearCommerceData(prisma);
    await prisma.$disconnect();
  });

  it('expires an overdue reservation once across concurrent sweepers', async () => {
    await retirePolicyAndCreateShortPolicy(prisma);
    const prepared = await prepareCart();
    const pendingCheckout = new CheckoutService(prisma, idempotency, audit, {
      async createPayment() {
        return { paymentId: `processing-${randomUUID()}`, status: 'processing' as const };
      },
    });
    const pending = await pendingCheckout.create(
      prepared.token,
      prepared.revision,
      `checkout-expiry-${randomUUID()}`,
      checkoutRequest(prepared),
      `request-expiry-${randomUUID()}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const expiry = new ReservationExpiryService(prisma, audit);
    const results = await Promise.all([expiry.sweepExpired(), expiry.sweepExpired()]);
    expect(results.sort()).toEqual([0, 1]);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: pending.orderId },
      include: { reservation: true, paymentAttempts: true },
    });
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.reservation.status).toBe(ReservationStatus.EXPIRED);
    expect(order.paymentAttempts).toHaveLength(1);
    expect(order.paymentAttempts[0]).toMatchObject({
      status: PaymentAttemptStatus.FAILED,
      failureCode: 'RESERVATION_EXPIRED',
    });
    await expect(
      prisma.cart.findUniqueOrThrow({ where: { id: order.cartId }, include: { items: true } }),
    ).resolves.toMatchObject({
      status: CartStatus.OPEN,
      items: [{ variantId: VARIANT_ID, quantity: 1 }],
    });
    await expect(
      prisma.inventoryMovement.count({
        where: { commandId: order.reservationId, type: InventoryMovementType.RESERVATION_EXPIRED },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.auditRecord.count({
        where: { action: 'commerce.reservation.expired', targetId: order.reservationId },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.outboxMessage.count({
        where: { eventType: 'commerce.reservation.expired', aggregateId: order.reservationId },
      }),
    ).resolves.toBe(1);
  });

  it('expires a Stripe requires-payment-method attempt without replacing its provider identity', async () => {
    await retirePolicyAndCreateShortPolicy(prisma);
    const prepared = await prepareCart();
    const stripeCheckout = new CheckoutService(
      prisma,
      idempotency,
      audit,
      new PaymentApplicationService(
        'stripe',
        {
          async createPayment() {
            return {
              paymentId: 'pi_1234567890',
              status: 'requires_payment_method' as const,
              clientSecret: 'pi_1234567890_secret_example',
            };
          },
        },
        'pk_test_example',
      ),
    );
    const pending = await stripeCheckout.create(
      prepared.token,
      prepared.revision,
      `checkout-stripe-expiry-${randomUUID()}`,
      {
        shippingAddress: ADDRESS,
        customerEmail: 'fulfillment@example.test',
        pricingFingerprint: prepared.pricingFingerprint,
      },
      `request-stripe-expiry-${randomUUID()}`,
    );
    expect(pending).toMatchObject({
      paymentProvider: 'stripe',
      paymentStatus: 'requires_payment_method',
      paymentConfiguration: {
        publishableKey: 'pk_test_example',
        clientSecret: 'pi_1234567890_secret_example',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await expect(new ReservationExpiryService(prisma, audit).sweepExpired()).resolves.toBe(1);
    await expect(
      prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: pending.orderId } }),
    ).resolves.toMatchObject({
      status: PaymentAttemptStatus.FAILED,
      providerPaymentId: 'pi_1234567890',
      providerReference: 'pi_1234567890',
      failureCode: 'RESERVATION_EXPIRED',
    });
  });

  it('expires a Stripe attempt whose provider identity was never created', async () => {
    await retirePolicyAndCreateShortPolicy(prisma);
    const prepared = await prepareCart();
    const stripeCheckout = new CheckoutService(
      prisma,
      idempotency,
      audit,
      new PaymentApplicationService(
        'stripe',
        {
          async createPayment() {
            throw new PaymentProviderUnavailableError();
          },
        },
        'pk_test_example',
      ),
    );
    await expect(
      stripeCheckout.create(
        prepared.token,
        prepared.revision,
        `checkout-stripe-unavailable-${randomUUID()}`,
        {
          shippingAddress: ADDRESS,
          customerEmail: 'fulfillment@example.test',
          pricingFingerprint: prepared.pricingFingerprint,
        },
        `request-stripe-unavailable-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    const order = await prisma.order.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      include: { paymentAttempts: true },
    });
    expect(order.paymentAttempts[0]).toMatchObject({
      status: PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD,
      providerPaymentId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await expect(new ReservationExpiryService(prisma, audit).sweepExpired()).resolves.toBe(1);
    await expect(
      prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: order.id } }),
    ).resolves.toMatchObject({
      status: PaymentAttemptStatus.FAILED,
      providerPaymentId: null,
      providerReference: null,
      failureCode: 'RESERVATION_EXPIRED',
    });
  });

  it('releases inventory after a definite Stripe creation rejection without inventing an ID', async () => {
    const prepared = await prepareCart();
    const stripeCheckout = new CheckoutService(
      prisma,
      idempotency,
      audit,
      new PaymentApplicationService(
        'stripe',
        {
          async createPayment() {
            throw new PaymentProviderRejectedError();
          },
        },
        'pk_test_example',
      ),
    );
    await expect(
      stripeCheckout.create(
        prepared.token,
        prepared.revision,
        `checkout-stripe-rejected-${randomUUID()}`,
        {
          shippingAddress: ADDRESS,
          customerEmail: 'fulfillment@example.test',
          pricingFingerprint: prepared.pricingFingerprint,
        },
        `request-stripe-rejected-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });

    const order = await prisma.order.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      include: { reservation: true, paymentAttempts: true, cart: true },
    });
    expect(order).toMatchObject({
      status: OrderStatus.PENDING_PAYMENT,
      reservation: { status: ReservationStatus.RELEASED },
      cart: { status: CartStatus.OPEN },
      paymentAttempts: [
        {
          status: PaymentAttemptStatus.FAILED,
          providerPaymentId: null,
          providerReference: null,
          failureCode: 'PAYMENT_PROVIDER_REJECTED',
        },
      ],
    });
  });

  it('lets payment success and expiry have one valid winner', async () => {
    await retirePolicyAndCreateShortPolicy(prisma);
    const prepared = await prepareCart();
    const delayedCheckout = new CheckoutService(prisma, idempotency, audit, {
      async createPayment() {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        return { paymentId: `late-${randomUUID()}`, status: 'succeeded' as const };
      },
    });
    const command = delayedCheckout.create(
      prepared.token,
      prepared.revision,
      `checkout-expiry-race-${randomUUID()}`,
      checkoutRequest(prepared),
      `request-expiry-race-${randomUUID()}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    const expiry = new ReservationExpiryService(prisma, audit);
    await expect(expiry.sweepExpired()).resolves.toBe(1);
    await expect(command).rejects.toMatchObject({ code: 'CHECKOUT_RESULT_CONFLICT' });

    const order = await prisma.order.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      include: { reservation: true, paymentAttempts: true },
    });
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.reservation.status).toBe(ReservationStatus.EXPIRED);
    expect(order.paymentAttempts[0]).toMatchObject({
      status: PaymentAttemptStatus.FAILED,
      failureCode: 'RESERVATION_EXPIRED',
    });
    await expect(
      prisma.inventoryMovement.count({
        where: { commandId: order.reservationId, type: InventoryMovementType.RESERVATION_EXPIRED },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.inventoryMovement.count({
        where: {
          commandId: order.reservationId,
          type: InventoryMovementType.RESERVATION_COMMITTED,
        },
      }),
    ).resolves.toBe(0);
  });

  it('projects a payment failure observed after expiry as an expired reservation', async () => {
    await retirePolicyAndCreateShortPolicy(prisma);
    const prepared = await prepareCart();
    const delayedCheckout = new CheckoutService(prisma, idempotency, audit, {
      async createPayment() {
        await new Promise((resolve) => setTimeout(resolve, 1_400));
        return { paymentId: `late-failure-${randomUUID()}`, status: 'failed' as const };
      },
    });

    const response = await delayedCheckout.create(
      prepared.token,
      prepared.revision,
      `checkout-expired-failure-${randomUUID()}`,
      checkoutRequest(prepared),
      `request-expired-failure-${randomUUID()}`,
    );

    expect(response.paymentStatus).toBe('failed');
    expect(response.reservationStatus).toBe('expired');
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: response.orderId },
      include: { reservation: true, paymentAttempts: true },
    });
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.reservation.status).toBe(ReservationStatus.EXPIRED);
    expect(order.paymentAttempts[0]).toMatchObject({
      status: PaymentAttemptStatus.FAILED,
      failureCode: 'RESERVATION_EXPIRED',
    });
    await expect(
      prisma.inventoryMovement.count({
        where: {
          commandId: order.reservationId,
          type: InventoryMovementType.RESERVATION_EXPIRED,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.inventoryMovement.count({
        where: {
          commandId: order.reservationId,
          type: InventoryMovementType.RESERVATION_RELEASED,
        },
      }),
    ).resolves.toBe(0);
  });

  it('runs the legal linear fulfillment path and decrements allocated stock only on shipment', async () => {
    const prepared = await prepareCart();
    const confirmed = await checkout.create(
      prepared.token,
      prepared.revision,
      `checkout-fulfillment-${randomUUID()}`,
      checkoutRequest(prepared),
      `request-fulfillment-${randomUUID()}`,
    );
    const group = await prisma.fulfillmentGroup.findFirstOrThrow({
      where: { orderId: confirmed.orderId },
    });
    const staff = await createStaff();
    const before = await prisma.inventoryBalance.findFirstOrThrow({
      where: { variantId: VARIANT_ID, warehouseId: group.warehouseId },
    });

    const picking = await fulfillment.transition(
      transitionInput(group.id, 1, 1, FulfillmentGroupStatus.PICKING),
      command(staff.id, 'picking'),
    );
    expect(picking).toMatchObject({ status: FulfillmentGroupStatus.PICKING, version: 2 });
    const packed = await fulfillment.transition(
      transitionInput(group.id, 2, 2, FulfillmentGroupStatus.PACKED),
      command(staff.id, 'packed'),
    );
    expect(packed).toMatchObject({ status: FulfillmentGroupStatus.PACKED, version: 3 });
    const shipped = await fulfillment.transition(
      {
        ...transitionInput(group.id, 3, 3, FulfillmentGroupStatus.SHIPPED),
        carrierCode: 'UPS',
        trackingReference: 'TRACK_123456',
      },
      command(staff.id, 'shipped'),
    );
    expect(shipped).toMatchObject({
      status: FulfillmentGroupStatus.SHIPPED,
      version: 4,
      carrierCode: 'UPS',
      trackingReference: 'TRACK_123456',
    });
    const afterShipment = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(afterShipment).toMatchObject({
      onHand: before.onHand - 1,
      allocated: before.allocated - 1,
    });
    await expect(
      prisma.inventoryMovement.count({
        where: { commandId: group.id, type: InventoryMovementType.FULFILLMENT_DECREMENT },
      }),
    ).resolves.toBe(1);

    const delivered = await fulfillment.transition(
      transitionInput(group.id, 4, 4, FulfillmentGroupStatus.DELIVERED),
      command(staff.id, 'delivered'),
    );
    expect(delivered).toMatchObject({ status: FulfillmentGroupStatus.DELIVERED, version: 5 });
    const afterDelivery = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(afterDelivery).toMatchObject({
      onHand: afterShipment.onHand,
      allocated: afterShipment.allocated,
    });
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: confirmed.orderId } }),
    ).resolves.toMatchObject({ status: OrderStatus.CONFIRMED });
  });

  it('ships split groups independently and applies each group decrement exactly once', async () => {
    const groups = await createSplitFulfillmentGroups();
    expect(groups).toHaveLength(2);
    const staff = await createStaff();
    const [first, second] = groups;
    const firstBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_variantId: { warehouseId: first.warehouseId, variantId: VARIANT_ID } },
    });
    const secondBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_variantId: { warehouseId: second.warehouseId, variantId: VARIANT_ID } },
    });

    await advanceToPacked(first.id, staff.id, 'first');
    const shipment = {
      ...transitionInput(first.id, 3, 31, FulfillmentGroupStatus.SHIPPED),
      carrierCode: 'UPS',
      trackingReference: 'SPLIT_FIRST_123',
    };
    const shipmentCommand = command(staff.id, 'split-first-shipped');
    const shipped = await fulfillment.transition(shipment, shipmentCommand);
    const replay = await fulfillment.transition(shipment, shipmentCommand);
    expect(replay).toEqual(shipped);
    await expect(
      prisma.fulfillmentGroup.findUniqueOrThrow({ where: { id: second.id } }),
    ).resolves.toMatchObject({ status: FulfillmentGroupStatus.ALLOCATED, version: 1 });
    await expect(
      prisma.inventoryBalance.findUniqueOrThrow({ where: { id: firstBalance.id } }),
    ).resolves.toMatchObject({
      onHand: firstBalance.onHand - first.items[0]!.quantity,
      allocated: firstBalance.allocated - first.items[0]!.quantity,
    });
    await expect(
      prisma.inventoryBalance.findUniqueOrThrow({ where: { id: secondBalance.id } }),
    ).resolves.toMatchObject({
      onHand: secondBalance.onHand,
      allocated: secondBalance.allocated,
    });
    await expect(
      prisma.inventoryMovement.count({
        where: { commandId: first.id, type: InventoryMovementType.FULFILLMENT_DECREMENT },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.inventoryMovement.count({
        where: { commandId: second.id, type: InventoryMovementType.FULFILLMENT_DECREMENT },
      }),
    ).resolves.toBe(0);

    await advanceToPacked(second.id, staff.id, 'second');
    await fulfillment.transition(
      {
        ...transitionInput(second.id, 3, 32, FulfillmentGroupStatus.SHIPPED),
        carrierCode: 'DHL',
        trackingReference: 'SPLIT_SECOND_123',
      },
      command(staff.id, 'split-second-shipped'),
    );
    await expect(
      prisma.inventoryMovement.count({
        where: { commandId: second.id, type: InventoryMovementType.FULFILLMENT_DECREMENT },
      }),
    ).resolves.toBe(1);
  });

  it('rejects skipped/backward and stale transitions, then safely replays or conflicts idempotency', async () => {
    const prepared = await prepareCart();
    const confirmed = await checkout.create(
      prepared.token,
      prepared.revision,
      `checkout-transition-${randomUUID()}`,
      checkoutRequest(prepared),
      `request-transition-${randomUUID()}`,
    );
    const group = await prisma.fulfillmentGroup.findFirstOrThrow({
      where: { orderId: confirmed.orderId },
    });
    const staff = await createStaff();
    await expect(
      fulfillment.transition(
        transitionInput(group.id, 1, 1, FulfillmentGroupStatus.PACKED),
        command(staff.id, 'skip'),
      ),
    ).rejects.toMatchObject({ code: 'FULFILLMENT_TRANSITION_INVALID', currentVersion: 1 });
    const firstInput = transitionInput(group.id, 1, 2, FulfillmentGroupStatus.PICKING);
    const firstCommand = command(staff.id, 'replay');
    const first = await fulfillment.transition(firstInput, firstCommand);
    await fulfillment.transition(
      transitionInput(group.id, 2, 6, FulfillmentGroupStatus.PACKED),
      command(staff.id, 'advance-before-replay'),
    );
    const replay = await fulfillment.transition(firstInput, firstCommand);
    expect(replay).toEqual(first);
    expect(replay).toMatchObject({ status: FulfillmentGroupStatus.PICKING, version: 2 });
    await expect(
      fulfillment.transition(
        { ...firstInput, targetStatus: FulfillmentGroupStatus.PACKED },
        firstCommand,
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      fulfillment.transition(
        transitionInput(group.id, 1, 3, FulfillmentGroupStatus.PACKED),
        command(staff.id, 'stale'),
      ),
    ).rejects.toMatchObject({ code: 'FULFILLMENT_REVISION_CONFLICT', currentVersion: 3 });
    await expect(
      fulfillment.transition(
        transitionInput(group.id, 3, 4, FulfillmentGroupStatus.ALLOCATED as never),
        command(staff.id, 'backward'),
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' });
  });

  it('retains immutable transition snapshots until idempotency expiry purges them', async () => {
    const prepared = await prepareCart();
    const confirmed = await checkout.create(
      prepared.token,
      prepared.revision,
      `checkout-retention-${randomUUID()}`,
      checkoutRequest(prepared),
      `request-retention-${randomUUID()}`,
    );
    const group = await prisma.fulfillmentGroup.findFirstOrThrow({
      where: { orderId: confirmed.orderId },
    });
    const staff = await createStaff();
    const firstInput = transitionInput(group.id, 1, 7, FulfillmentGroupStatus.PICKING);
    const firstCommand = command(staff.id, 'retention');
    const first = await fulfillment.transition(firstInput, firstCommand);
    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        actorType_actorId_operation_keyDigest: {
          actorType: 'STAFF',
          actorId: staff.id,
          operation: 'fulfillment.transition',
          keyDigest: createHash('sha256').update(firstCommand.idempotencyKey).digest('hex'),
        },
      },
    });
    if (!record.resultId) throw new Error('Expected fulfillment idempotency result reference.');
    const snapshot = await prisma.fulfillmentTransitionResult.findUniqueOrThrow({
      where: { id: record.resultId },
    });
    expect(first).toMatchObject({ status: FulfillmentGroupStatus.PICKING, version: 2 });
    await expect(
      prisma.fulfillmentTransitionResult.update({
        where: { id: snapshot.id },
        data: { version: 99 },
      }),
    ).rejects.toThrow();

    await prisma.idempotencyRecord.update({
      where: { id: record.id },
      data: {
        createdAt: new Date(Date.now() - 2_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const retention = new IdempotencyRetentionService(prisma, audit);
    await expect(
      retention.purgeExpired(250, {
        idempotencyKey: `retention-${randomUUID()}`,
        requestId: `retention-request-${randomUUID()}`,
        correlationId: `retention-correlation-${randomUUID()}`,
        actor: {
          type: 'system',
          id: 'idempotency-retention-scheduler',
          roles: ['IDEMPOTENCY_RETENTION'],
        },
        reason: 'Apply the idempotency record retention policy.',
      }),
    ).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      prisma.idempotencyRecord.findUnique({ where: { id: record.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.fulfillmentTransitionResult.findUnique({ where: { id: snapshot.id } }),
    ).resolves.toBeNull();
  });

  it('revalidates the persisted fulfiller role inside the mutation transaction', async () => {
    const prepared = await prepareCart();
    const confirmed = await checkout.create(
      prepared.token,
      prepared.revision,
      `checkout-role-${randomUUID()}`,
      checkoutRequest(prepared),
      `request-role-${randomUUID()}`,
    );
    const group = await prisma.fulfillmentGroup.findFirstOrThrow({
      where: { orderId: confirmed.orderId },
    });
    const staff = await createStaff();
    await prisma.userRole.deleteMany({ where: { userId: staff.id, role: RoleName.FULFILLER } });
    await expect(
      fulfillment.transition(
        transitionInput(group.id, 1, 5, FulfillmentGroupStatus.PICKING),
        command(staff.id, 'removed-role'),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      prisma.fulfillmentGroup.findUniqueOrThrow({ where: { id: group.id } }),
    ).resolves.toMatchObject({ status: FulfillmentGroupStatus.ALLOCATED, version: 1 });
  });

  it('enforces fulfillment transition, timestamp, and tracking invariants in PostgreSQL', async () => {
    const prepared = await prepareCart();
    const confirmed = await checkout.create(
      prepared.token,
      prepared.revision,
      `checkout-db-constraints-${randomUUID()}`,
      checkoutRequest(prepared),
      `request-db-constraints-${randomUUID()}`,
    );
    const group = await prisma.fulfillmentGroup.findFirstOrThrow({
      where: { orderId: confirmed.orderId },
    });
    const beforeCreated = new Date(group.createdAt.getTime() - 1);

    await expect(
      prisma.fulfillmentGroup.update({
        where: { id: group.id },
        data: { status: FulfillmentGroupStatus.PACKED, version: 2, packedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.fulfillmentGroup.update({
        where: { id: group.id },
        data: {
          status: FulfillmentGroupStatus.PICKING,
          version: 2,
          pickingStartedAt: beforeCreated,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.fulfillmentGroup.create({
        data: {
          orderId: confirmed.orderId,
          warehouseId: group.warehouseId,
          status: FulfillmentGroupStatus.SHIPPED,
          version: 1,
        },
      }),
    ).rejects.toThrow();

    await fulfillment.transition(
      transitionInput(group.id, 1, 40, FulfillmentGroupStatus.PICKING),
      command((await createStaff()).id, 'invariant-picking'),
    );
    const staff = await createStaff();
    await fulfillment.transition(
      transitionInput(group.id, 2, 41, FulfillmentGroupStatus.PACKED),
      command(staff.id, 'invariant-packed'),
    );
    await expect(
      prisma.$transaction(async (tx) => {
        // Keep chronology valid with the database clock so this assertion
        // reaches the deferred movement-coverage guard, not a clock-skew check.
        await tx.$executeRaw`
          UPDATE "FulfillmentGroup"
          SET "status" = 'SHIPPED', "version" = 4, "shippedAt" = CURRENT_TIMESTAMP,
              "carrierCode" = 'UPS', "trackingReference" = 'INVARIANT_123'
          WHERE "id" = ${group.id}::uuid
        `;
      }),
    ).rejects.toThrow('fulfillment shipment movements do not match group allocation');
  });

  async function advanceToPacked(groupId: string, staffId: string, suffix: string): Promise<void> {
    await fulfillment.transition(
      transitionInput(groupId, 1, 20, FulfillmentGroupStatus.PICKING),
      command(staffId, `${suffix}-picking`),
    );
    await fulfillment.transition(
      transitionInput(groupId, 2, 21, FulfillmentGroupStatus.PACKED),
      command(staffId, `${suffix}-packed`),
    );
  }

  async function createSplitFulfillmentGroups() {
    const balances = await prisma.inventoryBalance.findMany({
      where: { variantId: VARIANT_ID },
      include: { warehouse: true },
      orderBy: { warehouseId: 'asc' },
    });
    for (const balance of balances) {
      const onHand = balance.warehouse.code === 'MA-CASA-01' ? 0 : 1;
      await prisma.inventoryBalance.update({
        where: { id: balance.id },
        data: { onHand, version: { increment: 1 } },
      });
      await prisma.inventoryMovement.create({
        data: {
          warehouseId: balance.warehouseId,
          variantId: balance.variantId,
          type: InventoryMovementType.ADJUSTMENT,
          onHandDelta: onHand - balance.onHand,
          resultingOnHand: onHand,
          resultingReserved: balance.reserved,
          resultingAllocated: balance.allocated,
          resultingDamaged: balance.damaged,
          commandId: randomUUID(),
          commandSequence: 1,
          actorType: AuditActorType.SYSTEM,
          actorId: 'system:fulfillment-integration',
          reason: 'Constrain stock for split fulfillment shipment.',
        },
      });
    }
    const current = await carts.getCurrent(undefined);
    const updated = await carts.setItem(current.token, VARIANT_ID, 2, current.cart.revision);
    const preview = await checkout.preview(updated.token, updated.revision, {
      shippingAddress: ADDRESS,
    });
    const confirmed = await checkout.create(
      updated.token,
      updated.revision,
      `checkout-split-fulfillment-${randomUUID()}`,
      {
        shippingAddress: ADDRESS,
        customerEmail: 'split-fulfillment@example.test',
        pricingFingerprint: preview.pricingFingerprint,
        paymentMethodReference: 'stub-success',
      },
      `request-split-fulfillment-${randomUUID()}`,
    );
    return prisma.fulfillmentGroup.findMany({
      where: { orderId: confirmed.orderId },
      include: { items: true },
      orderBy: { warehouseId: 'asc' },
    });
  }

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

  async function createStaff(): Promise<{ id: string }> {
    const id = randomUUID();
    users.add(id);
    await prisma.user.create({
      data: {
        id,
        emailNormalized: `fulfillment-${id}@example.test`,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder',
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date(),
        userRoles: { create: [{ role: RoleName.FULFILLER }] },
      },
    });
    return { id };
  }
});

interface PreparedCart {
  token: string;
  revision: number;
  pricingFingerprint: string;
}

function checkoutRequest(prepared: PreparedCart) {
  return {
    shippingAddress: ADDRESS,
    customerEmail: 'fulfillment@example.test',
    pricingFingerprint: prepared.pricingFingerprint,
    paymentMethodReference: 'stub-success' as const,
  };
}

function transitionInput(
  fulfillmentGroupId: string,
  expectedVersion: number,
  suffix: number,
  targetStatus: FulfillmentGroupStatus,
) {
  return {
    fulfillmentGroupId,
    expectedVersion,
    idempotencyKey: `fulfillment-command-${suffix}-${randomUUID()}`,
    targetStatus: targetStatus as never,
    reason: `Apply ${targetStatus.toLowerCase()} transition.`,
  };
}

function command(actorId: string, suffix: string) {
  const id = randomUUID();
  return {
    requestId: `fulfillment-request-${suffix}-${id}`,
    correlationId: `fulfillment-correlation-${suffix}-${id}`,
    idempotencyKey: `fulfillment-context-${suffix}-${id}`,
    actor: { type: 'staff' as const, id: actorId, roles: [RoleName.FULFILLER] },
    reason: `Apply ${suffix} transition.`,
  };
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

async function retirePolicyAndCreateShortPolicy(prisma: PrismaService): Promise<void> {
  await prisma.commercePolicyVersion.update({
    where: { id: POLICY_ID },
    data: { lifecycle: CommercePolicyLifecycle.RETIRED, effectiveUntil: new Date() },
  });
  const priceBookVersion = await prisma.priceBookVersion.findFirstOrThrow({
    where: {
      version: 1,
      lifecycle: 'ACTIVE',
      priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
    },
  });
  await prisma.commercePolicyVersion.create({
    data: {
      id: randomUUID(),
      version: 2,
      lifecycle: CommercePolicyLifecycle.ACTIVE,
      effectiveFrom: new Date(Date.now() - 1_000),
      countryCode: 'US',
      currencyCode: 'USD',
      priceBookVersionId: priceBookVersion.id,
      shippingBaseMinor: 800,
      freeShippingThresholdMinor: 12_000,
      heavySurchargeMinor: 400,
      heavyThresholdGrams: 2_000,
      taxRateBasisPoints: 825,
      reservationDurationSeconds: 1,
      calculationVersion: 'us-usd-expiry-test',
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
      "InventoryAllocationPolicyWarehouse",
      "InventoryAllocationPolicyVersion",
      "InventoryAllocationPolicy",
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
