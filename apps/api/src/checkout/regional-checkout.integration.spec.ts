import { randomUUID } from 'node:crypto';
import { seedPhase3Commerce } from '../../prisma/seed-commerce';
import { seedInternationalCommerce } from '../../prisma/seed-international-commerce';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { CartService } from '../cart/cart.service';
import { AuditService } from '../audit/audit.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { OrderTimelineService } from '../orders/order-timeline.service';
import { StubPaymentProvider } from '../payments/stub-payment.provider';
import { PaymentApplicationService } from '../payments/payment-application.service';
import { PaymentOutcomeService } from '../payments/payment-outcome.service';
import { PaymentReconciliationExecutionService } from '../payments/payment-reconciliation-execution.service';
import { PaymentCompensationService } from '../payments/payment-compensation.service';
import { ReservationExpiryService } from '../reservation-expiry/reservation-expiry.service';
import { CheckoutService } from './checkout.service';
import type { ShippingAddressDto } from './checkout.dto';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Use the guarded integration runner.');
const VARIANT = '30000000-0000-4000-8000-000000000001';
const MARKETS = [
  ['US', 'USD', 'US', '94105', 11192, 11192],
  ['MA', 'MAD', 'MA', '20000', 115200, 11520],
  ['EU', 'EUR', 'FR', '75001', 11800, 12980],
  ['UK', 'GBP', 'GB', 'SW1A 1AA', 10500, 13125],
] as const;
describe('authoritative regional checkout', () => {
  const prisma = new PrismaService(databaseUrl);
  const carts = new CartService(prisma);
  const audit = new AuditService();
  const keys = new IdempotencyService(prisma);
  const stub = new StubPaymentProvider();
  const payments = new PaymentApplicationService('stub', stub);
  const timeline = new OrderTimelineService(prisma, Buffer.alloc(32, 8).toString('base64'));
  const checkout = new CheckoutService(prisma, keys, audit, payments, timeline);
  const outcomes = new PaymentOutcomeService(prisma, audit);
  const reconciliation = new PaymentReconciliationExecutionService(
    prisma,
    payments,
    outcomes,
    audit,
  );
  const compensation = new PaymentCompensationService(prisma, payments, audit);
  async function clear() {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CommerceMarket", "ReportingRateVersion", "Order", "InventoryReservation", "Cart", "CommercePolicyVersion", "Product", "Warehouse", "PriceBook", "InventoryAllocationPolicy", "AuditRecord", "OutboxMessage", "IdempotencyRecord" CASCADE',
    );
  }
  beforeEach(async () => {
    await clear();
    await seedPhase3Commerce(prisma);
    await seedInternationalCommerce(prisma);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await clear();
    await prisma.$disconnect();
  });
  function address(countryCode = 'FR', postalCode = '75001'): ShippingAddressDto {
    return {
      fullName: 'Local Buyer',
      line1: '1 Test Road',
      line2: '',
      city: 'Demo City',
      ...(countryCode === 'US' ? { state: 'CA' } : {}),
      countryCode,
      postalCode,
    };
  }
  async function prepare(market = 'EU') {
    const empty = await carts.getCurrent(undefined);
    const current = await carts.setItem(empty.token, VARIANT, 2, empty.cart.revision);
    const preview = await carts.previewMarket(current.token, market, current.revision);
    const selected = await carts.confirmMarket(
      current.token,
      market,
      preview.pricingFingerprint,
      current.revision,
    );
    return { token: current.token, revision: selected.cart.revision };
  }
  async function effects() {
    return {
      orders: await prisma.order.count(),
      reservations: await prisma.inventoryReservation.count(),
      attempts: await prisma.paymentAttempt.count(),
      movements: await prisma.inventoryMovement.count(),
      keys: await prisma.idempotencyRecord.count(),
      audit: await prisma.auditRecord.count(),
      outbox: await prisma.outboxMessage.count(),
      balances: await prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } }),
    };
  }
  async function request(prepared: Awaited<ReturnType<typeof prepare>>, destination = address()) {
    const preview = await checkout.preview(prepared.token, prepared.revision, {
      shippingAddress: destination,
    });
    return {
      preview,
      body: {
        shippingAddress: destination,
        customerEmail: 'buyer@example.test',
        pricingFingerprint: preview.pricingFingerprint,
        paymentMethodReference: 'stub-success' as const,
      },
    };
  }
  it.each(MARKETS)(
    'charges %s fixed prices and retains original %s / USD reporting',
    async (market, currency, country, postal, total, reported) => {
      const prepared = await prepare(market);
      const { preview, body } = await request(prepared, address(country, postal));
      expect(preview).toMatchObject({
        market,
        currency,
        taxTreatment: 'exclusive',
        totalMinor: total,
      });
      expect(preview).not.toHaveProperty('calculation');
      expect(preview).not.toHaveProperty('configuration');
      const charge = jest.spyOn(stub, 'createPayment');
      const key = randomUUID();
      const result = await checkout.create(
        prepared.token,
        prepared.revision,
        key,
        body,
        randomUUID(),
      );
      expect(charge).toHaveBeenCalledWith(
        expect.objectContaining({ amount: { currency, amountMinor: BigInt(total) } }),
        expect.any(Object),
      );
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: result.orderId },
        include: { paymentAttempts: true, reservation: true },
      });
      expect(order).toMatchObject({
        policyVersionId: null,
        currencyCode: currency,
        totalMinor: BigInt(total),
        reportingTotalMinor: BigInt(reported),
      });
      expect(order.paymentAttempts[0]).toMatchObject({
        currencyCode: currency,
        amountMinor: BigInt(total),
        status: 'SUCCEEDED',
      });
      expect(order.calculationSnapshot).toMatchObject({
        schemaVersion: 2,
        market,
        currency,
        countryCode: country,
        reporting: { totalMinor: reported },
      });
      expect(order.reportingTotalMinor).toBe(
        order.reportingSubtotalMinor! +
          order.reportingTaxMinor! +
          order.reportingShippingMinor! +
          order.reportingRoundingAdjustmentMinor!,
      );
      const config = await prisma.commerceMarketVersion.findUniqueOrThrow({
        where: { id: order.commerceMarketVersionId! },
      });
      expect(order.reservation.allocationPolicyVersionId).toBe(config.allocationPolicyVersionId);
      expect(
        await timeline.read(result.orderReference, result.guestOrderAccessToken),
      ).toMatchObject({ currency, totalMinor: total });
      const before = await effects();
      await prisma.commerceMarketVersion.update({
        where: { id: config.id },
        data: { lifecycle: 'RETIRED' },
      });
      expect(
        await checkout.create(prepared.token, prepared.revision, key, body, randomUUID()),
      ).toEqual(result);
      expect(await effects()).toEqual(before);
      expect(charge).toHaveBeenCalledTimes(1);
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { reportingRoundingAdjustmentMinor: 1n },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { reportingRateVersionId: randomUUID() },
        }),
      ).rejects.toThrow();
    },
  );
  it('requires explicit destination market confirmation before all effects', async () => {
    const prepared = await prepare('US');
    const before = await effects();
    const charge = jest.spyOn(stub, 'createPayment');
    await expect(
      checkout.preview(prepared.token, prepared.revision, { shippingAddress: address() }),
    ).rejects.toMatchObject({
      code: 'CART_MARKET_MISMATCH',
      requiredMarket: 'EU',
      requiredCurrency: 'EUR',
      cartRevision: prepared.revision,
    });
    await expect(
      checkout.create(
        prepared.token,
        prepared.revision,
        randomUUID(),
        {
          shippingAddress: address(),
          customerEmail: 'buyer@example.test',
          pricingFingerprint: 'a'.repeat(43),
          paymentMethodReference: 'stub-success',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CART_MARKET_MISMATCH' });
    expect(await effects()).toEqual(before);
    expect(charge).not.toHaveBeenCalled();
  });
  it('rejects malformed or mismatched inserted evidence at the database boundary', async () => {
    const prepared = await prepare();
    const { body } = await request(prepared);
    const result = await checkout.create(
      prepared.token,
      prepared.revision,
      randomUUID(),
      body,
      randomUUID(),
    );
    const original = await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } });
    const snapshot = original.calculationSnapshot as Prisma.InputJsonObject;
    const variants: Array<{ patch: Partial<Prisma.OrderUncheckedCreateInput>; message: string }> = [
      {
        patch: {
          commerceMarketVersionId: null,
          reportingRateVersionId: null,
          reportingSubtotalMinor: null,
          reportingTaxMinor: null,
          reportingShippingMinor: null,
          reportingTotalMinor: null,
          reportingRoundingAdjustmentMinor: null,
        },
        message: 'Order_evidence_mode_check',
      },
      { patch: { currencyCode: 'GBP' }, message: 'matching immutable evidence' },
      {
        patch: { priceBookVersionId: '61000000-0000-4000-8000-000000000001' },
        message: 'matching immutable evidence',
      },
      { patch: { reportingRateVersionId: randomUUID() }, message: 'matching immutable evidence' },
      {
        patch: {
          shippingAddressSnapshot: address('MA', '20000') as unknown as Prisma.InputJsonValue,
        },
        message: 'matching immutable evidence',
      },
      {
        patch: { reportingTotalMinor: original.reportingTotalMinor! + 1n },
        message: 'matching immutable evidence',
      },
      {
        patch: { calculationSnapshot: { ...snapshot, policy: {} } },
        message: 'matching immutable evidence',
      },
    ];
    for (const { patch, message } of variants) {
      await expect(
        prisma.order.create({
          data: {
            ...original,
            id: randomUUID(),
            reference: `PF-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
            calculationSnapshot: snapshot,
            shippingAddressSnapshot: original.shippingAddressSnapshot as Prisma.InputJsonValue,
            ...patch,
          },
        }),
      ).rejects.toThrow(message);
    }
    expect(await prisma.order.count()).toBe(1);
  });
  it('serializes competing regional checkouts without duplicate stock or charges', async () => {
    const prepared = await prepare();
    const second = await prepare();
    await prisma.inventoryBalance.updateMany({
      where: { variantId: VARIANT },
      data: { onHand: 0, version: { increment: 1 } },
    });
    const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { code: 'EU-CENTRAL-01' } });
    await prisma.inventoryBalance.update({
      where: { warehouseId_variantId: { warehouseId: warehouse.id, variantId: VARIANT } },
      data: { onHand: 2, version: { increment: 1 } },
    });
    const { body } = await request(prepared);
    const secondRequest = await request(second);
    const other = new PrismaService(databaseUrl);
    const otherCheckout = new CheckoutService(
      other,
      new IdempotencyService(other),
      audit,
      payments,
      new OrderTimelineService(other, Buffer.alloc(32, 8).toString('base64')),
    );
    const charge = jest.spyOn(stub, 'createPayment');
    try {
      const results = await Promise.allSettled([
        checkout.create(prepared.token, prepared.revision, randomUUID(), body, randomUUID()),
        otherCheckout.create(
          second.token,
          second.revision,
          randomUUID(),
          secondRequest.body,
          randomUUID(),
        ),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.inventoryReservation.count()).toBe(1);
      expect(charge).toHaveBeenCalledTimes(1);
      expect(await prisma.inventoryMovement.count({ where: { type: 'RESERVED' } })).toBe(1);
      expect(
        await prisma.inventoryMovement.count({ where: { type: 'RESERVATION_COMMITTED' } }),
      ).toBe(1);
    } finally {
      await other.$disconnect();
    }
  });
  it('maps an empty eligible warehouse route to a safe checkout conflict', async () => {
    const prepared = await prepare();
    await prisma.warehouse.updateMany({ data: { status: 'INACTIVE' } });
    const before = await effects();
    await expect(
      checkout.preview(prepared.token, prepared.revision, { shippingAddress: address() }),
    ).rejects.toMatchObject({ code: 'CHECKOUT_UNAVAILABLE' });
    expect(await effects()).toEqual(before);
  });
  it('rechecks cart expiry in the authoritative transaction after preflight', async () => {
    const prepared = await prepare();
    const { body } = await request(prepared);
    const begin = keys.begin.bind(keys);
    jest.spyOn(keys, 'begin').mockImplementationOnce(async (...args) => {
      const result = await begin(...args);
      await prisma.cart.update({
        where: { id: args[1].actor.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      return result;
    });
    await expect(
      checkout.create(prepared.token, prepared.revision, randomUUID(), body, randomUUID()),
    ).rejects.toMatchObject({ code: 'CART_NOT_FOUND' });
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.inventoryReservation.count()).toBe(0);
    expect(await prisma.paymentAttempt.count()).toBe(0);
  });
  it('retries an ambiguous provider failure with the same stored regional order', async () => {
    const prepared = await prepare('MA');
    const { body } = await request(prepared, address('MA', '20000'));
    const charge = jest
      .spyOn(payments, 'createPayment')
      .mockRejectedValueOnce(new Error('synthetic provider timeout'));
    const key = randomUUID();
    await expect(
      checkout.create(prepared.token, prepared.revision, key, body, randomUUID()),
    ).rejects.toThrow('synthetic provider timeout');
    expect(await prisma.order.count()).toBe(1);
    const result = await checkout.create(
      prepared.token,
      prepared.revision,
      key,
      body,
      randomUUID(),
    );
    expect(result).toMatchObject({ checkoutStatus: 'confirmed', currency: 'MAD' });
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.inventoryReservation.count()).toBe(1);
    expect(charge).toHaveBeenCalledTimes(2);
    expect(charge.mock.calls[0][1]?.idempotencyKey).toBe(charge.mock.calls[1][1]?.idempotencyKey);
  });
  it('releases declined regional reservations and preserves reporting evidence', async () => {
    const prepared = await prepare('UK');
    const { body } = await request(prepared, address('GB', 'SW1A 1AA'));
    const result = await checkout.create(
      prepared.token,
      prepared.revision,
      randomUUID(),
      { ...body, paymentMethodReference: 'stub-decline' },
      randomUUID(),
    );
    expect(result).toMatchObject({
      currency: 'GBP',
      paymentStatus: 'failed',
      reservationStatus: 'released',
    });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } })).toMatchObject({
      reportingTotalMinor: 13125n,
    });
    expect(await prisma.inventoryBalance.aggregate({ _sum: { reserved: true } })).toMatchObject({
      _sum: { reserved: 0 },
    });
  });
  it('rejects regional Stripe before a key, reservation or provider call', async () => {
    const prepared = await prepare();
    const before = await effects();
    const charge = jest.spyOn(stub, 'createPayment');
    const stripe = new CheckoutService(
      prisma,
      keys,
      audit,
      new PaymentApplicationService('stripe', stub),
      timeline,
    );
    await expect(
      stripe.preview(prepared.token, prepared.revision, { shippingAddress: address() }),
    ).rejects.toMatchObject({ code: 'REGIONAL_PAYMENT_PROVIDER_UNAVAILABLE' });
    await expect(
      stripe.create(
        prepared.token,
        prepared.revision,
        randomUUID(),
        {
          shippingAddress: address(),
          customerEmail: 'buyer@example.test',
          pricingFingerprint: 'a'.repeat(43),
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'REGIONAL_PAYMENT_PROVIDER_UNAVAILABLE' });
    expect(await effects()).toEqual(before);
    expect(charge).not.toHaveBeenCalled();
  });
  it('binds the full address, including EU destination changes with equal totals', async () => {
    const prepared = await prepare();
    const { body, preview } = await request(prepared);
    const changed = address('DE', '10115');
    const next = await checkout.preview(prepared.token, prepared.revision, {
      shippingAddress: changed,
    });
    expect(next.totalMinor).toBe(preview.totalMinor);
    expect(next.pricingFingerprint).not.toBe(preview.pricingFingerprint);
    const before = await effects();
    await expect(
      checkout.create(
        prepared.token,
        prepared.revision,
        randomUUID(),
        { ...body, shippingAddress: changed },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRICING_FINGERPRINT_CONFLICT' });
    expect(await effects()).toEqual(before);
  });
  it('blocks a missing eligible rate before claims without blocking cart browsing', async () => {
    const prepared = await prepare();
    // Owned test fixture has no orders; published rates cannot be deleted.
    expect(await prisma.order.count()).toBe(0);
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ReportingRateVersion" CASCADE');
    expect((await carts.getCurrent(prepared.token)).cart.currency).toBe('EUR');
    const before = await effects();
    await expect(
      checkout.create(
        prepared.token,
        prepared.revision,
        randomUUID(),
        {
          shippingAddress: address(),
          customerEmail: 'buyer@example.test',
          pricingFingerprint: 'a'.repeat(43),
          paymentMethodReference: 'stub-success',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INTERNATIONAL_CONFIGURATION_UNAVAILABLE' });
    expect(await effects()).toEqual(before);
  });
  it('pins reporting rate and uses a published stale fallback', async () => {
    const prepared = await prepare();
    const { body } = await request(prepared);
    const now = new Date();
    const rate = await prisma.reportingRateVersion.create({
      data: {
        sourceCurrency: 'EUR',
        targetCurrency: 'USD',
        revision: 2,
        numerator: 6n,
        denominator: 5n,
        sourceNote: 'fictional stale test rate',
        effectiveFrom: new Date(now.getTime() - 2000),
        freshUntil: new Date(now.getTime() - 1000),
      },
    });
    await prisma.reportingRateVersion.update({
      where: { id: rate.id },
      data: { publishedAt: now },
    });
    await expect(
      checkout.create(prepared.token, prepared.revision, randomUUID(), body, randomUUID()),
    ).rejects.toMatchObject({ code: 'PRICING_FINGERPRINT_CONFLICT' });
    const next = await request(prepared);
    expect(next.preview.totalMinor).toBe(11800);
    const result = await checkout.create(
      prepared.token,
      prepared.revision,
      randomUUID(),
      next.body,
      randomUUID(),
    );
    expect(await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } })).toMatchObject({
      reportingRateVersionId: rate.id,
      reportingTotalMinor: 14160n,
      calculationSnapshot: { reporting: { rate: { staleFallback: true } } },
    });
  });
  it.each([false, true])(
    'recovers expired regional payment with pinned retired route; unavailable=%s',
    async (unavailable) => {
      const config = await prisma.commerceMarketVersion.findFirstOrThrow({
        where: { market: { code: 'EU' }, lifecycle: 'ACTIVE' },
      });
      await prisma.commerceMarketVersion.update({
        where: { id: config.id },
        data: { lifecycle: 'RETIRED' },
      });
      const next = await prisma.commerceMarketVersion.create({
        data: {
          ...config,
          id: randomUUID(),
          version: 2,
          lifecycle: 'DRAFT',
          activatedAt: null,
          retiredAt: null,
          reservationDurationSeconds: 1,
        },
      });
      await prisma.commerceMarketVersion.update({
        where: { id: next.id },
        data: { lifecycle: 'ACTIVE' },
      });
      const prepared = await prepare();
      const { body } = await request(prepared);
      const create = jest
        .spyOn(stub, 'createPayment')
        .mockResolvedValueOnce({ paymentId: 'stub_late_regional', status: 'processing' });
      const key = randomUUID();
      const result = await checkout.create(
        prepared.token,
        prepared.revision,
        key,
        body,
        randomUUID(),
      );
      // Synthetic asynchronous stub evidence; the production stub is terminal.
      await prisma.$transaction(async (tx) => {
        const original = await tx.paymentAttempt.findFirstOrThrow({
          where: { orderId: result.orderId },
        });
        await tx.paymentAttempt.delete({ where: { id: original.id } });
        await tx.paymentAttempt.create({
          data: {
            ...original,
            providerPaymentId: 'stub_late_regional',
            providerReference: 'stub_late_regional',
          },
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await new ReservationExpiryService(prisma, audit).sweepExpired();
      const attempt = await prisma.paymentAttempt.findFirstOrThrow({
        where: { orderId: result.orderId },
      });
      await prisma.commerceMarketVersion.update({
        where: { id: next.id },
        data: { lifecycle: 'RETIRED' },
      });
      await prisma.commerceMarketVersion.updateMany({
        where: { lifecycle: 'ACTIVE', allocationPolicyVersionId: config.allocationPolicyVersionId },
        data: { lifecycle: 'RETIRED' },
      });
      await prisma.inventoryAllocationPolicyVersion.update({
        where: { id: config.allocationPolicyVersionId },
        data: { lifecycle: 'RETIRED', retiredAt: new Date() },
      });
      if (unavailable)
        await prisma.inventoryBalance.updateMany({
          where: { variantId: VARIANT },
          data: { onHand: 0, version: { increment: 1 } },
        });
      jest
        .spyOn(stub, 'retrievePayment')
        .mockResolvedValue({ paymentId: 'stub_late_regional', status: 'succeeded' });
      const outcome = await reconciliation.reconcile(attempt.id, randomUUID());
      if (unavailable) {
        expect(outcome.outcome).toBe('COMPENSATION_REQUIRED');
        if (outcome.outcome !== 'COMPENSATION_REQUIRED') throw new Error('Expected compensation');
        const refund = jest.spyOn(stub, 'refund');
        expect(await compensation.execute(outcome.compensationId, randomUUID())).toEqual({
          outcome: 'SUCCEEDED',
        });
        expect(await compensation.execute(outcome.compensationId, randomUUID())).toEqual({
          outcome: 'NO_OP',
        });
        expect(refund).toHaveBeenCalledTimes(1);
        expect(refund).toHaveBeenCalledWith(
          expect.objectContaining({ amount: { amountMinor: 11800n, currency: 'EUR' } }),
          expect.any(Object),
        );
      } else {
        expect(outcome.outcome).toBe('LATE_SUCCESS_CONFIRMED');
        const order = await prisma.order.findUniqueOrThrow({
          where: { id: result.orderId },
          include: { recoveryReservation: true },
        });
        expect(order.recoveryReservation?.allocationPolicyVersionId).toBe(
          config.allocationPolicyVersionId,
        );
        expect(
          (await checkout.create(prepared.token, prepared.revision, key, body, randomUUID()))
            .checkoutStatus,
        ).toBe('confirmed');
        expect(create).toHaveBeenCalledTimes(1);
      }
    },
  );
});
