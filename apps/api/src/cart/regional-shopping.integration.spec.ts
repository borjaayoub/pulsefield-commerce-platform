import { randomUUID } from 'node:crypto';
import { seedPhase3Commerce } from '../../prisma/seed-commerce';
import { seedInternationalCommerce } from '../../prisma/seed-international-commerce';
import { PrismaService } from '../database/prisma.service';
import { resolveIntegrationDatabaseUrl } from '../testing/integration-database-url';
import { CatalogService } from '../catalog/catalog.service';
import { CatalogQueryDto, CatalogSort } from '../catalog/catalog.dto';
import { CartService } from './cart.service';
import { digestCartToken } from './cart-cookie';
import { CheckoutService } from '../checkout/checkout.service';
import { AuditService } from '../audit/audit.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { StubPaymentProvider } from '../payments/stub-payment.provider';

if (!process.env.DATABASE_URL || !process.env.TEST_DATABASE_URL)
  throw new Error('Use the guarded integration runner.');
const url = resolveIntegrationDatabaseUrl(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
const variantId = '30000000-0000-4000-8000-000000000001';
const address = {
  fullName: 'Demo Buyer',
  line1: '1 Test Street',
  line2: '',
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  countryCode: 'US' as const,
};

describe('regional shopping and confirmed cart selection', () => {
  const prisma = new PrismaService(url);
  const carts = new CartService(prisma);
  const catalog = new CatalogService(prisma);
  const payments = new StubPaymentProvider();
  const checkout = new CheckoutService(
    prisma,
    new IdempotencyService(prisma),
    new AuditService(),
    payments,
  );
  async function clear() {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CommerceMarket", "ReportingRateVersion", "Order", "InventoryReservation", "Cart", "CommercePolicyVersion", "Product", "Warehouse", "PriceBook", "InventoryAllocationPolicy", "AuditRecord", "OutboxMessage", "IdempotencyRecord" CASCADE',
    );
  }
  beforeEach(async () => {
    await clear();
    await seedPhase3Commerce(prisma);
    await seedInternationalCommerce(prisma);
    await prisma.commercePolicyVersion.create({
      data: {
        version: 1,
        lifecycle: 'ACTIVE',
        effectiveFrom: new Date('2026-09-10Z'),
        countryCode: 'US',
        currencyCode: 'USD',
        priceBookVersionId: '61000000-0000-4000-8000-000000000001',
        shippingBaseMinor: 800,
        freeShippingThresholdMinor: 12000,
        heavySurchargeMinor: 400,
        heavyThresholdGrams: 2000,
        taxRateBasisPoints: 825,
        reservationDurationSeconds: 600,
        calculationVersion: 'us-usd-2026-09-10',
      },
    });
  });
  afterAll(async () => {
    await clear();
    await prisma.$disconnect();
  });
  async function prepared() {
    const empty = await carts.getCurrent(undefined);
    return carts.setItem(empty.token, variantId, 2, empty.cart.revision);
  }
  async function effects() {
    return {
      orders: await prisma.order.count(),
      reservations: await prisma.inventoryReservation.count(),
      payments: await prisma.paymentAttempt.count(),
      movements: await prisma.inventoryMovement.count(),
      audits: await prisma.auditRecord.count(),
      outbox: await prisma.outboxMessage.count(),
      keys: await prisma.idempotencyRecord.count(),
      balances: await prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } }),
    };
  }
  it.each([
    ['US', 'USD', 4800],
    ['MA', 'MAD', 48000],
    ['EU', 'EUR', 4500],
    ['UK', 'GBP', 4000],
  ] as const)(
    'uses fixed %s prices in catalog and cart without reporting rates',
    async (market, currency, price) => {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "ReportingRateVersion" CASCADE');
      const list = await catalog.list(
        Object.assign(new CatalogQueryDto(), { market, sort: CatalogSort.PRICE_ASC }),
      );
      expect(list).toMatchObject({ market, currency, taxTreatment: 'exclusive', totalItems: 12 });
      const detail = await catalog.getBySlug('aero-tempo-tee', market);
      expect(detail.product.variants[0]).toMatchObject({ priceMinor: price, currency });
      const current = await prepared();
      const before = await effects();
      const preview = await carts.previewMarket(current.token, market, current.revision);
      expect(preview.cart).toMatchObject({
        market,
        currency,
        subtotalMinor: price * 2,
        revision: current.revision,
      });
      expect((await carts.getCurrent(current.token)).cart.market).toBe('US');
      const confirmed = await carts.confirmMarket(
        current.token,
        market,
        preview.pricingFingerprint,
        current.revision,
      );
      expect(confirmed.cart.revision).toBe(current.revision + (market === 'US' ? 0 : 1));
      expect((await carts.getCurrent(current.token)).cart).toMatchObject({
        market,
        currency,
        subtotalMinor: price * 2,
      });
      expect(await effects()).toEqual(before);
      const unchanged = await carts.previewMarket(current.token, market, confirmed.cart.revision);
      expect(
        (
          await carts.confirmMarket(
            current.token,
            market,
            unchanged.pricingFingerprint,
            confirmed.cart.revision,
          )
        ).cart.revision,
      ).toBe(confirmed.cart.revision);
    },
  );
  it('rejects stale revision and fingerprints with no partial market change', async () => {
    const current = await prepared();
    const preview = await carts.previewMarket(current.token, 'EU', current.revision);
    await expect(
      carts.confirmMarket(current.token, 'EU', '0'.repeat(64), current.revision),
    ).rejects.toMatchObject({ code: 'CART_MARKET_PREVIEW_STALE' });
    const changed = await carts.setItem(current.token, variantId, 1, current.revision);
    await expect(
      carts.confirmMarket(current.token, 'EU', preview.pricingFingerprint, current.revision),
    ).rejects.toMatchObject({ code: 'CART_REVISION_CONFLICT' });
    expect((await carts.getCurrent(current.token)).cart).toMatchObject({
      market: 'US',
      revision: changed.revision,
    });
  });
  it('binds availability in the confirmation and retains unavailable lines on a fresh confirmation', async () => {
    const current = await prepared();
    const preview = await carts.previewMarket(current.token, 'EU', current.revision);
    await prisma.warehouse.updateMany({ data: { status: 'INACTIVE' } });
    await expect(
      carts.confirmMarket(current.token, 'EU', preview.pricingFingerprint, current.revision),
    ).rejects.toMatchObject({ code: 'CART_MARKET_PREVIEW_STALE' });
    const fresh = await carts.previewMarket(current.token, 'EU', current.revision);
    expect(fresh.cart.items[0]).toMatchObject({
      variantId,
      quantity: 2,
      available: 0,
      purchasable: false,
    });
    const changed = await carts.confirmMarket(
      current.token,
      'EU',
      fresh.pricingFingerprint,
      current.revision,
    );
    expect(changed.cart.hasUnavailableItems).toBe(true);
    await expect(
      carts.setItem(current.token, variantId, 3, changed.cart.revision),
    ).rejects.toMatchObject({ code: 'CART_ITEM_UNAVAILABLE' });
    expect(
      (await carts.removeItem(current.token, variantId, changed.cart.revision)).cart.items,
    ).toHaveLength(0);
  });
  it('serializes independent confirmations with exactly one winner', async () => {
    const current = await prepared();
    const eu = await carts.previewMarket(current.token, 'EU', current.revision);
    const ma = await carts.previewMarket(current.token, 'MA', current.revision);
    const other = new PrismaService(url);
    try {
      const outcomes = await Promise.allSettled([
        carts.confirmMarket(current.token, 'EU', eu.pricingFingerprint, current.revision),
        new CartService(other).confirmMarket(
          current.token,
          'MA',
          ma.pricingFingerprint,
          current.revision,
        ),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((o) => o.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
        code: 'CART_REVISION_CONFLICT',
      });
      expect((await carts.getCurrent(current.token)).cart.revision).toBe(current.revision + 1);
    } finally {
      await other.$disconnect();
    }
  });
  it.each(['MA', 'EU', 'UK'])(
    'rejects mismatched destination for %s before effects and claims',
    async (market) => {
      const current = await prepared();
      const preview = await carts.previewMarket(current.token, market, current.revision);
      const selected = await carts.confirmMarket(
        current.token,
        market,
        preview.pricingFingerprint,
        current.revision,
      );
      const before = await effects();
      const provider = jest.spyOn(payments, 'createPayment');
      try {
        await expect(
          checkout.preview(current.token, selected.cart.revision, { shippingAddress: address }),
        ).rejects.toMatchObject({ code: 'CART_MARKET_MISMATCH' });
        await expect(
          checkout.create(
            current.token,
            selected.cart.revision,
            randomUUID(),
            {
              shippingAddress: address,
              customerEmail: 'buyer@example.test',
              pricingFingerprint: preview.pricingFingerprint,
              paymentMethodReference: 'stub-success' as const,
            },
            randomUUID(),
          ),
        ).rejects.toMatchObject({ code: 'CART_MARKET_MISMATCH' });
        expect(provider).not.toHaveBeenCalled();
        expect(await effects()).toEqual(before);
      } finally {
        provider.mockRestore();
      }
    },
  );
  it('fails closed on missing market configuration and never creates an orphan cart', async () => {
    const current = await prepared();
    const eu = await prisma.commerceMarketVersion.findFirstOrThrow({
      where: { market: { code: 'EU' }, lifecycle: 'ACTIVE' },
    });
    await prisma.commerceMarketVersion.update({
      where: { id: eu.id },
      data: { lifecycle: 'RETIRED' },
    });
    await expect(carts.previewMarket(current.token, 'EU', current.revision)).rejects.toMatchObject({
      code: 'COMMERCE_CONFIGURATION_UNAVAILABLE',
    });
    await expect(
      catalog.list(Object.assign(new CatalogQueryDto(), { market: 'EU' })),
    ).rejects.toMatchObject({ code: 'COMMERCE_CONFIGURATION_UNAVAILABLE' });
    const us = await prisma.commerceMarketVersion.findFirstOrThrow({
      where: { market: { code: 'US' }, lifecycle: 'ACTIVE' },
    });
    await prisma.commerceMarketVersion.update({
      where: { id: us.id },
      data: { lifecycle: 'RETIRED' },
    });
    const count = await prisma.cart.count();
    await expect(carts.getCurrent(undefined)).rejects.toMatchObject({
      code: 'COMMERCE_CONFIGURATION_UNAVAILABLE',
    });
    expect(await prisma.cart.count()).toBe(count);
  });
  it('preserves US committed replay after configuration retirement and blocks converted cart selection', async () => {
    const current = await prepared();
    const preview = await checkout.preview(current.token, current.revision, {
      shippingAddress: address,
    });
    const key = randomUUID();
    const body = {
      shippingAddress: address,
      customerEmail: 'buyer@example.test',
      pricingFingerprint: preview.pricingFingerprint,
      paymentMethodReference: 'stub-success' as const,
    };
    const result = await checkout.create(current.token, current.revision, key, body, randomUUID());
    const before = await effects();
    const us = await prisma.commerceMarketVersion.findFirstOrThrow({
      where: { market: { code: 'US' }, lifecycle: 'ACTIVE' },
    });
    await prisma.commerceMarketVersion.update({
      where: { id: us.id },
      data: { lifecycle: 'RETIRED' },
    });
    expect(await checkout.create(current.token, current.revision, key, body, randomUUID())).toEqual(
      result,
    );
    expect(await effects()).toEqual(before);
    await expect(carts.previewMarket(current.token, 'EU', current.revision)).rejects.toMatchObject({
      code: 'CART_CHECKOUT_PENDING',
    });
    await expect(
      prisma.cart.update({
        where: { tokenDigest: digestCartToken(current.token) },
        data: { marketCode: 'EU', revision: { increment: 1 } },
      }),
    ).rejects.toThrow('cart market changes require');
  });
  it('enforces market selection revisions at the database boundary', async () => {
    const current = await prepared();
    await expect(
      prisma.cart.update({
        where: { tokenDigest: digestCartToken(current.token) },
        data: { marketCode: 'EU' },
      }),
    ).rejects.toThrow('cart market changes require');
    await expect(
      prisma.cart.update({
        where: { tokenDigest: digestCartToken(current.token) },
        data: { marketCode: 'XX', revision: { increment: 1 } },
      }),
    ).rejects.toThrow();
    await expect(carts.previewMarket(undefined, 'EU', current.revision)).rejects.toMatchObject({
      code: 'CART_REVISION_CONFLICT',
    });
    await expect(carts.previewMarket(current.token, 'EU')).rejects.toMatchObject({
      code: 'CART_REVISION_REQUIRED',
    });
  });

  it('retains missing-price lines without substitution and permits removal', async () => {
    const current = await prepared();
    const variant = await prisma.productVariant.create({
      data: {
        productId: '20000000-0000-4000-8000-000000000001',
        sku: 'PF-AERO-TEST-M',
        name: 'Unpriced test variant',
        optionValues: { size: 'M', color: 'Test' },
        weightGrams: 145,
        taxClass: 'apparel.standard',
        status: 'ACTIVE',
      },
    });
    const cart = await prisma.cart.findUniqueOrThrow({
      where: { tokenDigest: digestCartToken(current.token) },
    });
    await prisma.cartItem.create({ data: { cartId: cart.id, variantId: variant.id, quantity: 1 } });
    const preview = await carts.previewMarket(current.token, 'EU', current.revision);
    expect(preview.cart.items.find((item) => item.variantId === variant.id)).toMatchObject({
      currentUnitPriceMinor: null,
      currentLinePriceMinor: null,
      purchasable: false,
      currency: 'EUR',
    });
    const selected = await carts.confirmMarket(
      current.token,
      'EU',
      preview.pricingFingerprint,
      current.revision,
    );
    expect(selected.cart.items).toHaveLength(2);
    expect(
      (await carts.removeItem(current.token, variant.id, selected.cart.revision)).cart.items,
    ).toHaveLength(1);
  });

  it('rejects selection while a real checkout is pending', async () => {
    const current = await prepared();
    const preview = await checkout.preview(current.token, current.revision, {
      shippingAddress: address,
    });
    const pending = new CheckoutService(
      prisma,
      new IdempotencyService(prisma),
      new AuditService(),
      {
        async createPayment() {
          return { paymentId: 'stub_processing_test', status: 'processing' as const };
        },
      },
    );
    await pending.create(
      current.token,
      current.revision,
      randomUUID(),
      {
        shippingAddress: address,
        customerEmail: 'buyer@example.test',
        pricingFingerprint: preview.pricingFingerprint,
        paymentMethodReference: 'stub-success',
      },
      randomUUID(),
    );
    const before = await effects();
    await expect(carts.previewMarket(current.token, 'EU', current.revision)).rejects.toMatchObject({
      code: 'CART_CHECKOUT_PENDING',
    });
    await expect(
      carts.confirmMarket(current.token, 'EU', 'a'.repeat(64), current.revision),
    ).rejects.toMatchObject({ code: 'CART_CHECKOUT_PENDING' });
    expect(await effects()).toEqual(before);
  });

  it('rejects an obsolete preview after configuration replacement before a new claim', async () => {
    const current = await prepared();
    const us = await prisma.commerceMarketVersion.findFirstOrThrow({
      where: { market: { code: 'US' }, lifecycle: 'ACTIVE' },
    });
    await prisma.commerceMarketVersion.update({
      where: { id: us.id },
      data: { lifecycle: 'RETIRED' },
    });
    const next = await prisma.commerceMarketVersion.create({
      data: {
        ...us,
        id: randomUUID(),
        version: 2,
        lifecycle: 'DRAFT',
        activatedAt: null,
        retiredAt: null,
        taxRateBasisPoints: 900,
      },
    });
    await prisma.commerceMarketVersion.update({
      where: { id: next.id },
      data: { lifecycle: 'ACTIVE' },
    });
    const before = await effects();
    await expect(
      checkout.create(
        current.token,
        current.revision,
        randomUUID(),
        {
          shippingAddress: address,
          customerEmail: 'buyer@example.test',
          pricingFingerprint: 'a'.repeat(64),
          paymentMethodReference: 'stub-success',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRICING_FINGERPRINT_CONFLICT' });
    expect(await effects()).toEqual(before);
  });

  it('uses only the exact configured route, not every active policy warehouse', async () => {
    const current = await prepared();
    const eu = await prisma.commerceMarketVersion.findFirstOrThrow({
      where: { market: { code: 'EU' }, lifecycle: 'ACTIVE' },
    });
    const route = await prisma.inventoryAllocationPolicyVersion.findUniqueOrThrow({
      where: { id: eu.allocationPolicyVersionId },
    });
    const warehouse = await prisma.warehouse.findUniqueOrThrow({
      where: { code: 'EU-CENTRAL-01' },
    });
    await prisma.commerceMarketVersion.updateMany({
      where: { allocationPolicyVersionId: route.id, lifecycle: 'ACTIVE' },
      data: { lifecycle: 'RETIRED' },
    });
    await prisma.inventoryAllocationPolicyVersion.update({
      where: { id: route.id },
      data: { lifecycle: 'RETIRED', retiredAt: new Date() },
    });
    const nextRoute = await prisma.inventoryAllocationPolicyVersion.create({
      data: { policyId: route.policyId, version: 2 },
    });
    await prisma.inventoryAllocationPolicyWarehouse.create({
      data: { policyVersionId: nextRoute.id, warehouseId: warehouse.id, priority: 1 },
    });
    await prisma.inventoryAllocationPolicyVersion.update({
      where: { id: nextRoute.id },
      data: { lifecycle: 'ACTIVE', activatedAt: new Date() },
    });
    const config = await prisma.commerceMarketVersion.create({
      data: {
        ...eu,
        id: randomUUID(),
        version: 2,
        lifecycle: 'DRAFT',
        activatedAt: null,
        retiredAt: null,
        allocationPolicyVersionId: nextRoute.id,
      },
    });
    await prisma.commerceMarketVersion.update({
      where: { id: config.id },
      data: { lifecycle: 'ACTIVE' },
    });
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_variantId: { warehouseId: warehouse.id, variantId } },
    });
    const available = balance.onHand - balance.reserved - balance.allocated - balance.damaged;
    expect(
      (await carts.previewMarket(current.token, 'EU', current.revision)).cart.items[0].available,
    ).toBe(available);
    expect(
      (await catalog.getBySlug('aero-tempo-tee', 'EU')).product.variants.find(
        (variant) => variant.id === variantId,
      )?.available,
    ).toBe(available);
  });
});
