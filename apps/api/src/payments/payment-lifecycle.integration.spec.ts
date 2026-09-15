import { randomUUID } from 'node:crypto';
import type { PaymentProvider } from '@pulse-field/contracts';
import { seedPhase3Commerce } from '../../prisma/seed-commerce';
import { AuditService } from '../audit/audit.service';
import { CartService } from '../cart/cart.service';
import { CheckoutService } from '../checkout/checkout.service';
import { StubPaymentProvider } from './stub-payment.provider';
import { PrismaService } from '../database/prisma.service';
import {
  AuditActorType,
  CartStatus,
  CommercePolicyLifecycle,
  InventoryMovementType,
  OrderStatus,
  PaymentAttemptStatus,
  PaymentCompensationReason,
  PaymentCompensationStatus,
  PaymentWebhookEventType,
  PaymentWebhookInboxStatus,
  ReservationStatus,
} from '../generated/prisma/enums';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { PaymentOutcomeService } from './payment-outcome.service';
import { PaymentWebhookProcessor } from './payment-webhook.processor';
import { PaymentApplicationService } from './payment-application.service';
import { PaymentCompensationService } from './payment-compensation.service';
import { PaymentReconciliationExecutionService } from './payment-reconciliation-execution.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

const POLICY_ID = '63000000-0000-4000-8000-000000000001';
const VARIANT_ID = '30000000-0000-4000-8000-000000000001';
const ADDRESS = {
  fullName: 'Payment Lifecycle Buyer',
  line1: '100 Market Street',
  line2: '',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94105',
  countryCode: 'US' as const,
};

describe('payment lifecycle database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const carts = new CartService(prisma);
  const idempotency = new IdempotencyService(prisma);
  const processingProvider: Pick<PaymentProvider, 'createPayment'> = {
    createPayment: async () => ({ paymentId: `pi_${randomUUID()}`, status: 'processing' }),
  };
  const checkout = new CheckoutService(prisma, idempotency, new AuditService(), processingProvider);
  const successfulCheckout = new CheckoutService(
    prisma,
    idempotency,
    new AuditService(),
    new StubPaymentProvider(),
  );
  const retrievePayment = jest.fn();
  const refundPayment = jest.fn();
  const reconciliationPayments = new PaymentApplicationService('stripe', {
    createPayment: async () => ({ paymentId: 'unused', status: 'requires_payment_method' }),
    retrievePayment,
    refund: refundPayment,
  });
  const reconciliation = new PaymentReconciliationExecutionService(
    prisma,
    reconciliationPayments,
    new PaymentOutcomeService(prisma, new AuditService()),
    new AuditService(),
  );
  const compensations = new PaymentCompensationService(
    prisma,
    reconciliationPayments,
    new AuditService(),
  );
  const webhookProcessor = new PaymentWebhookProcessor(
    prisma,
    new PaymentOutcomeService(prisma, new AuditService()),
    reconciliation,
    compensations,
  );

  beforeEach(async () => {
    retrievePayment.mockReset();
    refundPayment.mockReset();
    await clearCommerceData(prisma);
    await seedPhase3Commerce(prisma);
    await createActivePolicy(prisma);
  });

  afterAll(async () => {
    await clearCommerceData(prisma);
    await prisma.$disconnect();
  });

  it('retains one authoritative payment transition trigger', async () => {
    const triggers = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT trigger_record.tgname AS name
      FROM pg_trigger AS trigger_record
      WHERE trigger_record.tgrelid = '"PaymentAttempt"'::regclass
        AND trigger_record.tgname IN (
          'PaymentAttempt_valid_state_transition',
          'PaymentAttempt_valid_transition'
        )
      ORDER BY trigger_record.tgname
    `;
    const supersededFunctions = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM pg_proc
      WHERE proname = 'enforce_payment_state_transition'
    `;

    expect(triggers).toEqual([{ name: 'PaymentAttempt_valid_transition' }]);
    expect(supersededFunctions[0]?.count).toBe(0n);
  });

  it('supports the pre-provider state, one identity attachment, and processing transition', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);

    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { reservation: true, cart: true, paymentAttempts: true },
      }),
    ).resolves.toMatchObject({
      status: OrderStatus.PENDING_PAYMENT,
      reservation: { status: ReservationStatus.ACTIVE },
      cart: { status: CartStatus.CHECKOUT_PENDING },
      paymentAttempts: [{ status: PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD }],
    });

    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          providerPaymentId: 'pi_phase4_requires_001',
          providerReference: 'pi_phase4_requires_001',
        },
      }),
    ).resolves.toMatchObject({ status: PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD });

    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { providerPaymentId: 'pi_phase4_requires_changed' },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: PaymentAttemptStatus.PROCESSING },
      }),
    ).resolves.toMatchObject({ status: PaymentAttemptStatus.PROCESSING });
  });

  it('permits requires-payment-method failure and rejects terminal reversal or snapshot mutation', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);

    await releaseReservation(
      order.id,
      ReservationStatus.RELEASED,
      InventoryMovementType.RESERVATION_RELEASED,
    );
    const failed = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(failed).toMatchObject({
      status: PaymentAttemptStatus.FAILED,
      failureCode: 'PAYMENT_DECLINED',
    });

    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: PaymentAttemptStatus.SUCCEEDED, failureCode: null },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { amountMinor: failed.amountMinor + 1n },
      }),
    ).rejects.toThrow();
  });

  it('allows only approved Stripe failures before a provider identity is attached', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);

    await releaseReservation(
      order.id,
      ReservationStatus.RELEASED,
      InventoryMovementType.RESERVATION_RELEASED,
      false,
      false,
      'PAYMENT_PROVIDER_REJECTED',
    );
    await expect(
      prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({
      status: PaymentAttemptStatus.FAILED,
      providerPaymentId: null,
      providerReference: null,
      failureCode: 'PAYMENT_PROVIDER_REJECTED',
    });

    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { failureCode: 'PAYMENT_DECLINED' },
      }),
    ).rejects.toThrow();
  });

  it('retains a failed attempt when a replacement becomes the single active attempt', async () => {
    const order = await createPendingOrder();
    const original = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: order.id } });

    await prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.update({
        where: { id: original.id },
        data: {
          status: PaymentAttemptStatus.FAILED,
          providerPaymentId: `pi_failed_${original.id}`,
          providerReference: `pi_failed_${original.id}`,
          failureCode: 'PAYMENT_DECLINED',
        },
      });
      await tx.paymentAttempt.create({
        data: {
          orderId: order.id,
          status: PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD,
          provider: 'stripe',
          paymentMethodReference: 'payment-element-retry',
          amountMinor: order.totalMinor,
          currencyCode: order.currencyCode,
        },
      });
    });

    const attempts = await prisma.paymentAttempt.findMany({ where: { orderId: order.id } });
    expect(attempts.map(({ status }) => status).sort()).toEqual([
      PaymentAttemptStatus.FAILED,
      PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD,
    ]);
  });

  it('accepts only the complete late-success manual-resolution projection', async () => {
    const order = await createPendingOrder();

    await expect(
      prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.MANUAL_RESOLUTION },
      }),
    ).rejects.toThrow();

    await expect(
      releaseReservation(
        order.id,
        ReservationStatus.EXPIRED,
        InventoryMovementType.RESERVATION_EXPIRED,
        true,
        true,
        'PAYMENT_DECLINED',
        false,
      ),
    ).rejects.toThrow();
    await expect(
      releaseReservation(
        order.id,
        ReservationStatus.EXPIRED,
        InventoryMovementType.RESERVATION_EXPIRED,
        true,
        true,
        'PAYMENT_DECLINED',
        true,
        { provider: 'other-provider' },
      ),
    ).rejects.toThrow();
    await expect(
      releaseReservation(
        order.id,
        ReservationStatus.EXPIRED,
        InventoryMovementType.RESERVATION_EXPIRED,
        true,
        true,
        'PAYMENT_DECLINED',
        true,
        { amountMinor: order.totalMinor + 1n },
      ),
    ).rejects.toThrow();

    await releaseReservation(
      order.id,
      ReservationStatus.EXPIRED,
      InventoryMovementType.RESERVATION_EXPIRED,
      true,
    );

    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: {
          reservation: true,
          paymentAttempts: true,
          paymentCompensations: true,
          fulfillmentGroups: true,
          cart: true,
        },
      }),
    ).resolves.toMatchObject({
      status: OrderStatus.MANUAL_RESOLUTION,
      reservation: { status: ReservationStatus.EXPIRED },
      cart: { status: CartStatus.OPEN },
      paymentAttempts: [{ status: PaymentAttemptStatus.SUCCEEDED }],
      paymentCompensations: [
        {
          reason: PaymentCompensationReason.LATE_SUCCESS_STOCK_UNAVAILABLE,
          status: PaymentCompensationStatus.REQUIRED,
          amountMinor: order.totalMinor,
          currencyCode: order.currencyCode,
        },
      ],
      fulfillmentGroups: [],
    });
    await expect(
      prisma.order.update({
        where: { id: order.id },
        data: { totalMinor: { increment: 1 } },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CONFIRMED },
      }),
    ).rejects.toThrow();

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: order.id } });
    await expect(
      prisma.paymentCompensation.create({
        data: {
          orderId: order.id,
          paymentAttemptId: attempt.id,
          reason: PaymentCompensationReason.LATE_SUCCESS_STOCK_UNAVAILABLE,
          provider: attempt.provider,
          amountMinor: order.totalMinor,
          currencyCode: order.currencyCode,
        },
      }),
    ).rejects.toThrow();

    await addFailedHistory(order.id, order.totalMinor, order.currencyCode);
    await expect(prisma.paymentAttempt.count({ where: { orderId: order.id } })).resolves.toBe(2);
  });

  it('enforces immutable compensation money and the required processing lifecycle', async () => {
    const order = await createPendingOrder();
    await releaseReservation(
      order.id,
      ReservationStatus.EXPIRED,
      InventoryMovementType.RESERVATION_EXPIRED,
      true,
    );
    const compensation = await prisma.paymentCompensation.findUniqueOrThrow({
      where: {
        paymentAttemptId: (
          await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: order.id } })
        ).id,
      },
    });

    await expect(
      prisma.paymentCompensation.update({
        where: { id: compensation.id },
        data: { status: PaymentCompensationStatus.PROCESSING },
      }),
    ).rejects.toThrow();

    const processingStartedAt = new Date();
    await prisma.paymentCompensation.update({
      where: { id: compensation.id },
      data: {
        status: PaymentCompensationStatus.PROCESSING,
        providerCompensationId: `refund_${randomUUID().replaceAll('-', '')}`,
        processingStartedAt,
      },
    });
    await expect(
      prisma.paymentCompensation.update({
        where: { id: compensation.id },
        data: { providerCompensationId: `refund_${randomUUID().replaceAll('-', '')}` },
      }),
    ).rejects.toThrow();
    await prisma.paymentCompensation.update({
      where: { id: compensation.id },
      data: { status: PaymentCompensationStatus.SUCCEEDED, completedAt: processingStartedAt },
    });

    await expect(
      prisma.paymentCompensation.update({
        where: { id: compensation.id },
        data: { status: PaymentCompensationStatus.FAILED, failureCode: 'PROVIDER_REJECTED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentCompensation.update({
        where: { id: compensation.id },
        data: { amountMinor: { increment: 1 } },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentCompensation.delete({ where: { id: compensation.id } }),
    ).rejects.toThrow();
  });

  it('permits a processing compensation to retain verified terminal failure evidence', async () => {
    const order = await createPendingOrder();
    await releaseReservation(
      order.id,
      ReservationStatus.EXPIRED,
      InventoryMovementType.RESERVATION_EXPIRED,
      true,
    );
    const compensation = await prisma.paymentCompensation.findFirstOrThrow({
      where: { orderId: order.id },
    });
    const processingStartedAt = new Date();
    await prisma.paymentCompensation.update({
      where: { id: compensation.id },
      data: {
        status: PaymentCompensationStatus.PROCESSING,
        providerCompensationId: `refund_${randomUUID().replaceAll('-', '')}`,
        processingStartedAt,
      },
    });
    await expect(
      prisma.paymentCompensation.update({
        where: { id: compensation.id },
        data: {
          status: PaymentCompensationStatus.FAILED,
          completedAt: processingStartedAt,
          failureCode: 'PROVIDER_REJECTED',
        },
      }),
    ).resolves.toMatchObject({
      status: PaymentCompensationStatus.FAILED,
      failureCode: 'PROVIDER_REJECTED',
    });
  });

  it('rejects compensation outside its matching manual-resolution payment', async () => {
    const order = await createSuccessfulOrder();
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: order.id } });
    await expect(
      prisma.paymentCompensation.create({
        data: {
          orderId: order.id,
          paymentAttemptId: attempt.id,
          reason: PaymentCompensationReason.LATE_SUCCESS_STOCK_UNAVAILABLE,
          provider: attempt.provider,
          amountMinor: order.totalMinor,
          currencyCode: order.currencyCode,
        },
      }),
    ).rejects.toThrow();
  });

  it('allows failed history beside one confirmed success and rejects a second success', async () => {
    const order = await createSuccessfulOrder();
    await addFailedHistory(order.id, order.totalMinor, order.currencyCode);

    const attempts = await prisma.paymentAttempt.findMany({ where: { orderId: order.id } });
    expect(attempts.map(({ status }) => status).sort()).toEqual([
      PaymentAttemptStatus.FAILED,
      PaymentAttemptStatus.SUCCEEDED,
    ]);

    await expect(
      prisma.paymentAttempt.create({
        data: {
          orderId: order.id,
          status: PaymentAttemptStatus.SUCCEEDED,
          provider: 'stripe',
          paymentMethodReference: 'payment-element-duplicate',
          providerPaymentId: `pi_duplicate_${randomUUID()}`,
          amountMinor: order.totalMinor,
          currencyCode: order.currencyCode,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects payment history whose money differs from the immutable order total', async () => {
    const order = await createSuccessfulOrder();
    await expect(
      addFailedHistory(order.id, order.totalMinor + 1n, order.currencyCode),
    ).rejects.toThrow();
  });

  it('processes ordered Stripe evidence exactly once through the durable inbox', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    const providerPaymentId = `pi_${randomUUID().replaceAll('-', '')}`;
    const processing = await createWebhookInbox(
      order,
      attempt.id,
      providerPaymentId,
      PaymentWebhookEventType.PROCESSING,
    );

    await webhookProcessor.consume(processing.id);
    await expect(
      prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({
      status: PaymentAttemptStatus.PROCESSING,
      providerPaymentId,
    });

    const succeeded = await createWebhookInbox(
      order,
      attempt.id,
      providerPaymentId,
      PaymentWebhookEventType.SUCCEEDED,
    );
    await webhookProcessor.consume(succeeded.id);
    await webhookProcessor.consume(succeeded.id);

    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: {
          reservation: true,
          cart: { include: { items: true } },
          paymentAttempts: true,
          fulfillmentGroups: { include: { items: true } },
        },
      }),
    ).resolves.toMatchObject({
      status: OrderStatus.CONFIRMED,
      reservation: { status: ReservationStatus.COMMITTED },
      cart: { status: CartStatus.CONVERTED, items: [] },
      paymentAttempts: [{ status: PaymentAttemptStatus.SUCCEEDED, providerPaymentId }],
      fulfillmentGroups: [{ status: 'ALLOCATED' }],
    });
    await expect(
      prisma.paymentWebhookInbox.findMany({
        where: { id: { in: [processing.id, succeeded.id] } },
        orderBy: { providerCreatedAt: 'asc' },
      }),
    ).resolves.toMatchObject([
      { status: PaymentWebhookInboxStatus.PROCESSED, processingAttempts: 1 },
      { status: PaymentWebhookInboxStatus.PROCESSED, processingAttempts: 1 },
    ]);
    await expect(
      prisma.inventoryMovement.count({
        where: {
          commandId: order.reservationId,
          type: InventoryMovementType.RESERVATION_COMMITTED,
        },
      }),
    ).resolves.toBe(1);
  });

  it('retrieves authoritative state before applying out-of-order success', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    const providerPaymentId = `pi_${randomUUID().replaceAll('-', '')}`;
    const inbox = await createWebhookInbox(
      order,
      attempt.id,
      providerPaymentId,
      PaymentWebhookEventType.SUCCEEDED,
    );
    retrievePayment.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(webhookProcessor.consume(inbox.id)).rejects.toThrow('provider unavailable');
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    ).resolves.toMatchObject({ status: OrderStatus.PENDING_PAYMENT });
    retrievePayment.mockResolvedValue({ paymentId: providerPaymentId, status: 'succeeded' });

    await webhookProcessor.consume(inbox.id);

    await expect(
      prisma.paymentWebhookInbox.findUniqueOrThrow({ where: { id: inbox.id } }),
    ).resolves.toMatchObject({
      status: PaymentWebhookInboxStatus.TERMINAL_FAILURE,
      failureCode: 'RECONCILIATION_REQUIRED',
    });
    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { reservation: true, cart: true, paymentAttempts: true, fulfillmentGroups: true },
      }),
    ).resolves.toMatchObject({
      status: OrderStatus.CONFIRMED,
      reservation: { status: ReservationStatus.COMMITTED },
      cart: { status: CartStatus.CONVERTED },
      paymentAttempts: [{ status: PaymentAttemptStatus.SUCCEEDED }],
      fulfillmentGroups: [{ status: 'ALLOCATED' }],
    });
  });

  it('applies a verified in-order failure and releases inventory once', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    const providerPaymentId = `pi_${randomUUID().replaceAll('-', '')}`;
    const failed = await createWebhookInbox(
      order,
      attempt.id,
      providerPaymentId,
      PaymentWebhookEventType.FAILED,
    );

    await webhookProcessor.consume(failed.id);

    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { reservation: true, cart: true, paymentAttempts: true },
      }),
    ).resolves.toMatchObject({
      status: OrderStatus.PENDING_PAYMENT,
      reservation: { status: ReservationStatus.RELEASED },
      cart: { status: CartStatus.OPEN },
      paymentAttempts: [
        {
          status: PaymentAttemptStatus.FAILED,
          providerPaymentId,
          failureCode: 'PAYMENT_DECLINED',
        },
      ],
    });
    await expect(
      prisma.paymentWebhookInbox.findUniqueOrThrow({ where: { id: failed.id } }),
    ).resolves.toMatchObject({ status: PaymentWebhookInboxStatus.PROCESSED });
  });

  it('reconciles skipped-forward authoritative success without trusting the webhook order', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    const providerPaymentId = `pi_${randomUUID().replaceAll('-', '')}`;
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { providerPaymentId, providerReference: providerPaymentId },
    });
    retrievePayment.mockResolvedValue({ paymentId: providerPaymentId, status: 'succeeded' });

    await expect(reconciliation.reconcile(attempt.id, 'reconcile-skipped')).resolves.toEqual({
      outcome: 'APPLIED',
    });
    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { reservation: true, paymentAttempts: true, fulfillmentGroups: true },
      }),
    ).resolves.toMatchObject({
      status: OrderStatus.CONFIRMED,
      reservation: { status: ReservationStatus.COMMITTED },
      recoveryReservationId: null,
      paymentAttempts: [{ status: PaymentAttemptStatus.SUCCEEDED }],
      fulfillmentGroups: [{ status: 'ALLOCATED' }],
    });
  });

  it('confirms a late success through one separately committed recovery reservation', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    await releaseReservation(
      order.id,
      ReservationStatus.EXPIRED,
      InventoryMovementType.RESERVATION_EXPIRED,
      false,
      true,
      'RESERVATION_EXPIRED',
    );
    const failed = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    retrievePayment.mockResolvedValue({
      paymentId: failed.providerPaymentId,
      status: 'succeeded',
    });

    const first = await reconciliation.reconcile(attempt.id, 'reconcile-late-success');
    expect(first).toMatchObject({ outcome: 'LATE_SUCCESS_CONFIRMED' });
    await expect(
      reconciliation.reconcile(attempt.id, 'reconcile-late-success-retry'),
    ).resolves.toEqual({ outcome: 'NO_OP' });

    const recovered = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: {
        reservation: true,
        recoveryReservation: { include: { items: true } },
        cart: { include: { items: true } },
        paymentAttempts: true,
        paymentCompensations: true,
        fulfillmentGroups: true,
      },
    });
    expect(recovered).toMatchObject({
      status: OrderStatus.CONFIRMED,
      reservation: { status: ReservationStatus.EXPIRED },
      recoveryReservation: { status: ReservationStatus.COMMITTED },
      cart: { status: CartStatus.CONVERTED, items: [] },
      paymentAttempts: [{ status: PaymentAttemptStatus.SUCCEEDED, failureCode: null }],
      paymentCompensations: [],
      fulfillmentGroups: [{ status: 'ALLOCATED' }],
    });
    await expect(
      prisma.inventoryMovement.groupBy({
        by: ['type'],
        where: { commandId: recovered.recoveryReservationId! },
        _count: true,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: InventoryMovementType.RESERVED, _count: 1 }),
        expect.objectContaining({ type: InventoryMovementType.RESERVATION_COMMITTED, _count: 1 }),
      ]),
    );
  });

  it('creates and executes one idempotent full compensation when late-success stock is unavailable', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    await releaseReservation(
      order.id,
      ReservationStatus.EXPIRED,
      InventoryMovementType.RESERVATION_EXPIRED,
      false,
      true,
      'RESERVATION_EXPIRED',
    );
    const failed = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    await prisma.inventoryBalance.updateMany({
      where: { variantId: VARIANT_ID },
      data: { onHand: 0, version: { increment: 1 } },
    });
    retrievePayment.mockResolvedValue({
      paymentId: failed.providerPaymentId,
      status: 'succeeded',
    });

    const recovery = await reconciliation.reconcile(attempt.id, 'reconcile-no-stock');
    expect(recovery).toMatchObject({ outcome: 'COMPENSATION_REQUIRED' });
    if (recovery.outcome !== 'COMPENSATION_REQUIRED') throw new Error('Expected compensation.');
    refundPayment.mockResolvedValue({ refundId: 're_late_success_001', status: 'succeeded' });

    await expect(compensations.execute(recovery.compensationId, 'compensate-1')).resolves.toEqual({
      outcome: 'SUCCEEDED',
    });
    await expect(
      compensations.execute(recovery.compensationId, 'compensate-retry'),
    ).resolves.toEqual({ outcome: 'NO_OP' });
    expect(refundPayment).toHaveBeenCalledTimes(1);
    expect(refundPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: failed.providerPaymentId,
        amount: { amountMinor: order.totalMinor, currency: 'USD' },
        reason: 'late_success_stock_unavailable',
      }),
      expect.objectContaining({
        idempotencyKey: `payment-compensation-${recovery.compensationId}`,
      }),
    );
    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { recoveryReservation: true, fulfillmentGroups: true, paymentCompensations: true },
      }),
    ).resolves.toMatchObject({
      status: OrderStatus.MANUAL_RESOLUTION,
      recoveryReservation: null,
      fulfillmentGroups: [],
      paymentCompensations: [
        {
          status: PaymentCompensationStatus.SUCCEEDED,
          providerCompensationId: 're_late_success_001',
          amountMinor: order.totalMinor,
        },
      ],
    });
  });

  it('resumes webhook compensation while provider evidence remains processing', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    await releaseReservation(
      order.id,
      ReservationStatus.EXPIRED,
      InventoryMovementType.RESERVATION_EXPIRED,
      false,
      true,
      'RESERVATION_EXPIRED',
    );
    const failed = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    await prisma.inventoryBalance.updateMany({
      where: { variantId: VARIANT_ID },
      data: { onHand: 0, version: { increment: 1 } },
    });
    const inbox = await createWebhookInbox(
      order,
      attempt.id,
      failed.providerPaymentId!,
      PaymentWebhookEventType.SUCCEEDED,
    );
    retrievePayment.mockResolvedValue({
      paymentId: failed.providerPaymentId,
      status: 'succeeded',
    });
    refundPayment
      .mockResolvedValueOnce({ refundId: 're_resumed_001', status: 'processing' })
      .mockResolvedValue({ refundId: 're_resumed_001', status: 'succeeded' });

    await expect(webhookProcessor.consume(inbox.id)).rejects.toThrow('remains pending');
    const required = await prisma.paymentCompensation.findUniqueOrThrow({
      where: { paymentAttemptId: attempt.id },
    });
    expect(required.status).toBe(PaymentCompensationStatus.PROCESSING);

    await webhookProcessor.consume(inbox.id);
    await expect(
      prisma.paymentCompensation.findUniqueOrThrow({ where: { id: required.id } }),
    ).resolves.toMatchObject({
      status: PaymentCompensationStatus.SUCCEEDED,
      providerCompensationId: 're_resumed_001',
    });
    expect(refundPayment).toHaveBeenCalledTimes(2);
    expect(refundPayment.mock.calls[0]?.[1].idempotencyKey).toBe(
      refundPayment.mock.calls[1]?.[1].idempotencyKey,
    );
  });

  it('leaves required compensation retryable when the provider call is unavailable', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    await releaseReservation(
      order.id,
      ReservationStatus.EXPIRED,
      InventoryMovementType.RESERVATION_EXPIRED,
      true,
    );
    const compensation = await prisma.paymentCompensation.findUniqueOrThrow({
      where: { paymentAttemptId: attempt.id },
    });
    refundPayment.mockRejectedValue(new Error('provider unavailable'));

    await expect(compensations.execute(compensation.id, 'compensate-unavailable')).rejects.toThrow(
      'provider unavailable',
    );
    await expect(
      prisma.paymentCompensation.findUniqueOrThrow({ where: { id: compensation.id } }),
    ).resolves.toMatchObject({
      status: PaymentCompensationStatus.REQUIRED,
      providerCompensationId: null,
    });
  });

  it('advances processing compensation only with the same provider identity', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    await releaseReservation(
      order.id,
      ReservationStatus.EXPIRED,
      InventoryMovementType.RESERVATION_EXPIRED,
      true,
    );
    const compensation = await prisma.paymentCompensation.findUniqueOrThrow({
      where: { paymentAttemptId: attempt.id },
    });
    refundPayment.mockResolvedValueOnce({ refundId: 're_processing_001', status: 'processing' });
    await expect(compensations.execute(compensation.id, 'compensate-processing')).resolves.toEqual({
      outcome: 'PROCESSING',
    });
    refundPayment.mockResolvedValueOnce({ refundId: 're_changed_001', status: 'succeeded' });
    await expect(compensations.execute(compensation.id, 'compensate-mismatch')).rejects.toThrow(
      'could not be applied safely',
    );
    await expect(
      prisma.paymentCompensation.findUniqueOrThrow({ where: { id: compensation.id } }),
    ).resolves.toMatchObject({
      status: PaymentCompensationStatus.PROCESSING,
      providerCompensationId: 're_processing_001',
    });
    refundPayment.mockResolvedValueOnce({ refundId: 're_processing_001', status: 'succeeded' });
    await expect(compensations.execute(compensation.id, 'compensate-complete')).resolves.toEqual({
      outcome: 'SUCCEEDED',
    });
    await expect(
      prisma.paymentCompensation.findUniqueOrThrow({ where: { id: compensation.id } }),
    ).resolves.toMatchObject({
      status: PaymentCompensationStatus.SUCCEEDED,
      providerCompensationId: 're_processing_001',
    });
  });

  it('records verified terminal compensation failure without retrying money movement', async () => {
    const order = await createPendingOrder();
    const attempt = await replaceWithRequiresPaymentMethod(order.id);
    await releaseReservation(
      order.id,
      ReservationStatus.EXPIRED,
      InventoryMovementType.RESERVATION_EXPIRED,
      true,
    );
    const compensation = await prisma.paymentCompensation.findUniqueOrThrow({
      where: { paymentAttemptId: attempt.id },
    });
    refundPayment.mockResolvedValue({ refundId: 're_failed_001', status: 'failed' });

    await expect(compensations.execute(compensation.id, 'compensate-failed')).resolves.toEqual({
      outcome: 'FAILED',
    });
    await expect(
      compensations.execute(compensation.id, 'compensate-failed-retry'),
    ).resolves.toEqual({ outcome: 'NO_OP' });
    expect(refundPayment).toHaveBeenCalledTimes(1);
    await expect(
      prisma.paymentCompensation.findUniqueOrThrow({ where: { id: compensation.id } }),
    ).resolves.toMatchObject({
      status: PaymentCompensationStatus.FAILED,
      providerCompensationId: 're_failed_001',
      failureCode: 'PROVIDER_REFUND_FAILED',
    });
  });

  async function createPendingOrder() {
    return createOrder(checkout);
  }

  async function createSuccessfulOrder() {
    return createOrder(successfulCheckout);
  }

  async function createOrder(checkoutService: CheckoutService) {
    const current = await carts.getCurrent(undefined);
    const updated = await carts.setItem(current.token, VARIANT_ID, 1, current.cart.revision);
    const preview = await checkoutService.preview(updated.token, updated.revision, {
      shippingAddress: ADDRESS,
    });
    const response = await checkoutService.create(
      updated.token,
      updated.revision,
      `phase4-checkout-${randomUUID()}`,
      {
        shippingAddress: ADDRESS,
        pricingFingerprint: preview.pricingFingerprint,
        paymentMethodReference: 'stub-success',
      },
      `phase4-request-${randomUUID()}`,
    );
    return prisma.order.findUniqueOrThrow({ where: { id: response.orderId } });
  }

  async function addFailedHistory(
    orderId: string,
    amountMinor: bigint,
    currencyCode: string,
  ): Promise<void> {
    await prisma.paymentAttempt.create({
      data: {
        orderId,
        status: PaymentAttemptStatus.FAILED,
        provider: 'stripe',
        paymentMethodReference: 'payment-element-history',
        providerPaymentId: `pi_history_${randomUUID()}`,
        failureCode: 'PAYMENT_DECLINED',
        amountMinor,
        currencyCode,
        createdAt: new Date('2026-09-12T00:00:00.000Z'),
      },
    });
  }

  async function replaceWithRequiresPaymentMethod(orderId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.deleteMany({ where: { orderId } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      return tx.paymentAttempt.create({
        data: {
          orderId,
          status: PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD,
          provider: 'stripe',
          paymentMethodReference: 'payment-element',
          amountMinor: order.totalMinor,
          currencyCode: order.currencyCode,
        },
      });
    });
  }

  async function createWebhookInbox(
    order: { id: string; reference: string; totalMinor: bigint; currencyCode: string },
    paymentAttemptId: string,
    providerPaymentId: string,
    eventType: PaymentWebhookEventType,
  ) {
    const status =
      eventType === PaymentWebhookEventType.PROCESSING
        ? 'PROCESSING'
        : eventType === PaymentWebhookEventType.SUCCEEDED
          ? 'SUCCEEDED'
          : 'FAILED';
    return prisma.paymentWebhookInbox.create({
      data: {
        provider: 'stripe',
        providerEventId: `evt_${randomUUID().replaceAll('-', '')}`,
        eventType,
        providerObjectId: providerPaymentId,
        apiVersion: '2026-07-29.dahlia',
        livemode: false,
        providerCreatedAt: new Date(Date.now() + (status === 'SUCCEEDED' ? 1_000 : 0)),
        normalizedData: {
          schemaVersion: 1,
          paymentAttemptId,
          orderReference: order.reference,
          amountMinor: Number(order.totalMinor),
          currencyCode: order.currencyCode,
          paymentStatus: status,
        },
        payloadDigest: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      },
    });
  }

  async function releaseReservation(
    orderId: string,
    reservationStatus: typeof ReservationStatus.RELEASED | typeof ReservationStatus.EXPIRED,
    movementType:
      | typeof InventoryMovementType.RESERVATION_RELEASED
      | typeof InventoryMovementType.RESERVATION_EXPIRED,
    manualResolution = false,
    attachProviderIdentity = true,
    failureCode = 'PAYMENT_DECLINED',
    createCompensation = manualResolution,
    compensationOverrides: { provider?: string; amountMinor?: bigint } = {},
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { reservation: { include: { items: true } }, paymentAttempts: true },
      });
      const attempt = order.paymentAttempts[0]!;

      for (const [index, item] of order.reservation.items.entries()) {
        const balance = await tx.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_variantId: { warehouseId: item.warehouseId, variantId: item.variantId },
          },
        });
        const updated = await tx.inventoryBalance.update({
          where: { id: balance.id },
          data: { reserved: { decrement: item.quantity }, version: { increment: 1 } },
        });
        await tx.inventoryMovement.create({
          data: {
            warehouseId: item.warehouseId,
            variantId: item.variantId,
            type: movementType,
            reservedDelta: -item.quantity,
            resultingOnHand: updated.onHand,
            resultingReserved: updated.reserved,
            resultingAllocated: updated.allocated,
            resultingDamaged: updated.damaged,
            commandId: order.reservation.id,
            commandSequence: 5000 + index,
            actorType: AuditActorType.SYSTEM,
            actorId: 'payment-lifecycle-test',
            reason: manualResolution ? 'late-payment-success' : 'payment-failed',
          },
        });
      }

      await tx.inventoryReservation.update({
        where: { id: order.reservation.id },
        data: { status: reservationStatus },
      });
      await tx.cart.update({ where: { id: order.cartId }, data: { status: CartStatus.OPEN } });
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: manualResolution
          ? {
              status: PaymentAttemptStatus.SUCCEEDED,
              providerPaymentId: `pi_late_${attempt.id}`,
              providerReference: `pi_late_${attempt.id}`,
            }
          : {
              status: PaymentAttemptStatus.FAILED,
              ...(attachProviderIdentity
                ? {
                    providerPaymentId: `pi_failed_${attempt.id}`,
                    providerReference: `pi_failed_${attempt.id}`,
                  }
                : {}),
              failureCode,
            },
      });
      if (manualResolution) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.MANUAL_RESOLUTION },
        });
        if (createCompensation) {
          await tx.paymentCompensation.create({
            data: {
              orderId: order.id,
              paymentAttemptId: attempt.id,
              reason: PaymentCompensationReason.LATE_SUCCESS_STOCK_UNAVAILABLE,
              provider: compensationOverrides.provider ?? attempt.provider,
              amountMinor: compensationOverrides.amountMinor ?? order.totalMinor,
              currencyCode: order.currencyCode,
            },
          });
        }
      }
    });
  }
});

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
      calculationVersion: 'us-usd-2026-09-13',
    },
  });
}

async function clearCommerceData(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "PaymentWebhookInbox", "FulfillmentGroupItem", "FulfillmentGroup", "PaymentAttempt", "OrderLine", "Order",
      "InventoryReservationItem", "InventoryReservation", "CartItem", "Cart",
      "CommercePolicyVersion", "InventoryMovement", "InventoryBalance", "Warehouse",
      "VariantPrice", "PriceBookVersion", "PriceBook", "ProductMedia", "ProductCategory",
      "Category", "ProductVariant", "ProductSlug", "Product"
    CASCADE
  `);
}
