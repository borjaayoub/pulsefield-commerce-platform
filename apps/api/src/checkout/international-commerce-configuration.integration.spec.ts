import { randomUUID } from 'node:crypto';
import { seedPhase3Commerce } from '../../prisma/seed-commerce';
import { seedInternationalCommerce } from '../../prisma/seed-international-commerce';
import { PrismaService } from '../database/prisma.service';
import { resolveIntegrationDatabaseUrl } from '../testing/integration-database-url';
import { calculateInternationalCommerce } from './international-commerce.calculation';
import {
  resolveInternationalConfiguration,
  InternationalConfigurationUnavailableError,
} from './international-commerce-configuration.reader';

if (!process.env.DATABASE_URL || !process.env.TEST_DATABASE_URL)
  throw new Error('Use the guarded integration runner.');
const url = resolveIntegrationDatabaseUrl(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);

describe('international commerce configuration persistence', () => {
  const prisma = new PrismaService(url);
  async function clear() {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "CommerceMarket", "ReportingRateVersion", "Order", "InventoryReservation", "Cart", "CommercePolicyVersion", "Product", "Warehouse", "PriceBook", "InventoryAllocationPolicy", "AuditRecord", "OutboxMessage", "IdempotencyRecord" CASCADE`,
    );
  }
  beforeEach(async () => {
    await clear();
    await seedPhase3Commerce(prisma);
    await seedInternationalCommerce(prisma);
  });
  afterAll(async () => {
    await clear();
    await prisma.$disconnect();
  });
  async function active(market = 'EU') {
    return prisma.commerceMarketVersion.findFirstOrThrow({
      where: { lifecycle: 'ACTIVE', market: { code: market } },
    });
  }
  async function draft(market = 'EU', version = 2) {
    const current = await active(market);
    return prisma.commerceMarketVersion.create({
      data: {
        ...current,
        id: randomUUID(),
        version,
        lifecycle: 'DRAFT',
        activatedAt: null,
        retiredAt: null,
      },
    });
  }
  async function rate(revision: number, effectiveFrom: Date, freshUntil: Date) {
    return prisma.reportingRateVersion.create({
      data: {
        sourceCurrency: 'EUR',
        targetCurrency: 'USD',
        revision,
        numerator: 2n,
        denominator: 1n,
        sourceNote: 'demo test rate',
        effectiveFrom,
        freshUntil,
      },
    });
  }
  async function publish(id: string) {
    return prisma.reportingRateVersion.update({
      where: { id },
      data: { publishedAt: new Date(0) },
    });
  }
  async function counts() {
    return {
      markets: await prisma.commerceMarket.count(),
      configs: await prisma.commerceMarketVersion.count(),
      books: await prisma.priceBook.count(),
      prices: await prisma.variantPrice.count(),
      routes: await prisma.inventoryAllocationPolicy.count(),
      rates: await prisma.reportingRateVersion.count(),
      movements: await prisma.inventoryMovement.count(),
      audits: await prisma.auditRecord.count(),
      outbox: await prisma.outboxMessage.count(),
    };
  }

  it('repeats the seed without changing records or inventory effects', async () => {
    const before = await counts();
    const configBefore = await prisma.commerceMarketVersion.findMany({ orderBy: { id: 'asc' } });
    const ratesBefore = await prisma.reportingRateVersion.findMany({ orderBy: { id: 'asc' } });
    const stock = await prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } });
    await seedInternationalCommerce(prisma);
    expect(await counts()).toEqual(before);
    expect(before).toMatchObject({
      markets: 4,
      configs: 4,
      books: 4,
      prices: 160,
      routes: 3,
      rates: 4,
    });
    expect(await prisma.commerceMarketVersion.findMany({ orderBy: { id: 'asc' } })).toEqual(
      configBefore,
    );
    expect(await prisma.reportingRateVersion.findMany({ orderBy: { id: 'asc' } })).toEqual(
      ratesBefore,
    );
    expect(await prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } })).toEqual(stock);
  });

  it.each(
    'US MA GB AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(
      ' ',
    ),
  )('resolves supported destination %s from persisted configuration', async (country) => {
    const result = await resolveInternationalConfiguration(prisma, country);
    expect(result.countryCodes).toContain(country);
    expect(result.market).toBe(
      country === 'US' ? 'US' : country === 'MA' ? 'MA' : country === 'GB' ? 'UK' : 'EU',
    );
    expect(Object.isFrozen(result.policy)).toBe(true);
    expect(Object.isFrozen(result.reportingRate)).toBe(true);
  });

  it.each([
    ['US', 11192, 11192],
    ['MA', 115200, 11520],
    ['FR', 11800, 12980],
    ['GB', 10500, 13125],
  ] as const)(
    'feeds persisted %s evidence to the 6.1 calculator',
    async (country, total, reporting) => {
      const config = await resolveInternationalConfiguration(prisma, country);
      const price = await prisma.variantPrice.findFirstOrThrow({
        where: { priceBookVersionId: config.priceBookVersionId, variant: { sku: 'PF-AERO-BLU-L' } },
        include: { variant: true },
      });
      const result = calculateInternationalCommerce({
        version: 1,
        market: config.market,
        currency: config.currency,
        policy: config.policy,
        reportingRate: config.reportingRate,
        lines: [
          {
            variantId: price.variantId,
            currency: config.currency,
            quantity: 2,
            unitPriceMinor: Number(price.amountMinor),
            weightGrams: price.variant.weightGrams,
          },
        ],
      });
      expect(result.totalMinor).toBe(total);
      expect(result.reporting.totalMinor).toBe(reporting);
    },
  );

  it.each(['EU', 'UK', 'ZZ', 'us', 'US\nprivate-sentinel'])(
    'fails closed for unsupported destination %s',
    async (country) => {
      await expect(resolveInternationalConfiguration(prisma, country)).rejects.toThrow(
        InternationalConfigurationUnavailableError,
      );
    },
  );

  it('ignores unpublished and future-effective rates and selects the newest eligible publication', async () => {
    const future = await rate(2, new Date('2099-01-01Z'), new Date('2099-02-01Z'));
    await publish(future.id);
    const unpublished = await rate(3, new Date('2026-10-05T00:00:01Z'), new Date('2099-02-01Z'));
    expect((await resolveInternationalConfiguration(prisma, 'FR')).reportingRate.revision).toBe(1);
    await publish(unpublished.id);
    expect((await resolveInternationalConfiguration(prisma, 'FR')).reportingRate.revision).toBe(3);
  });

  it('uses the latest stale eligible rate after the database freshness deadline', async () => {
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const stale = await rate(2, new Date('2026-10-05T00:00:01Z'), clock.now);
    await publish(stale.id);
    const resolved = await resolveInternationalConfiguration(prisma, 'FR');
    expect(resolved.reportingRate.revisionId).toBe(stale.id);
    expect(resolved.reportingRate.staleFallback).toBe(true);
  });

  it('rejects a missing eligible rate without leaking database errors or changing effects', async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE "ReportingRateVersion" CASCADE`);
    const before = await counts();
    await expect(resolveInternationalConfiguration(prisma, 'FR')).rejects.toThrow(
      'International commerce configuration is unavailable.',
    );
    expect(await counts()).toEqual(before);
  });

  it('permits only a newer draft activation after immutable retirement', async () => {
    const old = await active();
    const next = await draft();
    await expect(
      prisma.commerceMarketVersion.update({
        where: { id: old.id },
        data: { shippingBaseMinor: 12 },
      }),
    ).rejects.toThrow('active market values are immutable');
    await expect(prisma.commerceMarketVersion.delete({ where: { id: old.id } })).rejects.toThrow(
      'commerce market history is immutable',
    );
    await prisma.commerceMarketVersion.update({
      where: { id: old.id },
      data: { lifecycle: 'RETIRED' },
    });
    await expect(resolveInternationalConfiguration(prisma, 'FR')).rejects.toThrow(
      InternationalConfigurationUnavailableError,
    );
    await prisma.commerceMarketVersion.update({
      where: { id: next.id },
      data: { lifecycle: 'ACTIVE' },
    });
    await expect(
      prisma.commerceMarketVersion.update({ where: { id: old.id }, data: { lifecycle: 'ACTIVE' } }),
    ).rejects.toThrow('retired market history is immutable');
    expect(
      (await resolveInternationalConfiguration(prisma, 'FR')).policy.configurationVersion,
    ).toBe(2);
  });

  it('serializes two independent draft activations so exactly one wins', async () => {
    const old = await active();
    const drafts = [await draft('EU', 2), await draft('EU', 3)];
    await prisma.commerceMarketVersion.update({
      where: { id: old.id },
      data: { lifecycle: 'RETIRED' },
    });
    const other = new PrismaService(url);
    try {
      const outcomes = await Promise.allSettled([
        prisma.commerceMarketVersion.update({
          where: { id: drafts[0].id },
          data: { lifecycle: 'ACTIVE' },
        }),
        other.commerceMarketVersion.update({
          where: { id: drafts[1].id },
          data: { lifecycle: 'ACTIVE' },
        }),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.commerceMarketVersion.count({
          where: { marketId: old.marketId, lifecycle: 'ACTIVE' },
        }),
      ).toBe(1);
    } finally {
      await other.$disconnect();
    }
  });

  it('rejects wrong price/routing references and incomplete coverage', async () => {
    const pending = await draft();
    const us = await active('US');
    await prisma.commerceMarketVersion.update({
      where: { id: pending.id },
      data: { priceBookVersionId: us.priceBookVersionId },
    });
    await expect(
      prisma.commerceMarketVersion.update({
        where: { id: pending.id },
        data: { lifecycle: 'ACTIVE' },
      }),
    ).rejects.toThrow('market dependencies are invalid');
    const eu = await active();
    await prisma.commerceMarketVersion.update({
      where: { id: pending.id },
      data: {
        priceBookVersionId: eu.priceBookVersionId,
        allocationPolicyVersionId: us.allocationPolicyVersionId,
      },
    });
    await expect(
      prisma.commerceMarketVersion.update({
        where: { id: pending.id },
        data: { lifecycle: 'ACTIVE' },
      }),
    ).rejects.toThrow('market dependencies are invalid');
    const book = await prisma.priceBook.create({
      data: { code: 'EU-INCOMPLETE', name: 'test', marketCode: 'EU', currencyCode: 'EUR' },
    });
    const version = await prisma.priceBookVersion.create({
      data: { priceBookId: book.id, version: 1 },
    });
    await prisma.priceBookVersion.update({
      where: { id: version.id },
      data: { lifecycle: 'ACTIVE', effectiveFrom: new Date(), activatedAt: new Date() },
    });
    await prisma.commerceMarketVersion.update({
      where: { id: pending.id },
      data: {
        priceBookVersionId: version.id,
        allocationPolicyVersionId: eu.allocationPolicyVersionId,
      },
    });
    await expect(
      prisma.commerceMarketVersion.update({
        where: { id: pending.id },
        data: { lifecycle: 'ACTIVE' },
      }),
    ).rejects.toThrow('market price coverage is incomplete');
  });

  it('protects active dependencies and retained price book identity on the reverse mutation paths', async () => {
    const config = await active();
    const bookVersion = await prisma.priceBookVersion.findUniqueOrThrow({
      where: { id: config.priceBookVersionId },
    });
    await expect(
      prisma.priceBook.update({
        where: { id: bookVersion.priceBookId },
        data: { currencyCode: 'USD' },
      }),
    ).rejects.toThrow('referenced market price book identity is immutable');
    await expect(
      prisma.priceBookVersion.update({
        where: { id: bookVersion.id },
        data: { lifecycle: 'RETIRED', effectiveUntil: new Date(), retiredAt: new Date() },
      }),
    ).rejects.toThrow('active market price dependency is immutable');
    await expect(
      prisma.inventoryAllocationPolicyVersion.update({
        where: { id: config.allocationPolicyVersionId },
        data: { lifecycle: 'RETIRED', retiredAt: new Date() },
      }),
    ).rejects.toThrow('active market allocation dependency is immutable');
  });

  it.each([
    ['countryCodes', ['GB']],
    ['countryCodes', ['FR', 'DE']],
    ['countryCodes', ['FR', 'FR']],
    ['taxRateBasisPoints', 10001],
    ['heavySurchargeBasisPoints', -1],
    ['shippingBaseMinor', -1],
    ['taxTreatment', 'inclusive'],
  ] as const)('rejects invalid draft field %s = %j', async (field, value) => {
    const pending = await draft();
    await expect(
      prisma.commerceMarketVersion.update({ where: { id: pending.id }, data: { [field]: value } }),
    ).rejects.toThrow();
  });

  it('retains published reporting evidence and rejects bad pairs, ratios and freshness', async () => {
    const published = await prisma.reportingRateVersion.findFirstOrThrow({
      where: { sourceCurrency: 'EUR' },
    });
    await expect(
      prisma.reportingRateVersion.update({ where: { id: published.id }, data: { numerator: 3n } }),
    ).rejects.toThrow('published reporting rates are immutable');
    await expect(
      prisma.reportingRateVersion.delete({ where: { id: published.id } }),
    ).rejects.toThrow('published reporting rates are immutable');
    const base = {
      sourceCurrency: 'EUR',
      targetCurrency: 'USD',
      revision: 10,
      numerator: 1n,
      denominator: 0n,
      sourceNote: 'test',
      effectiveFrom: new Date(),
      freshUntil: new Date('2099-01-01Z'),
    };
    await expect(prisma.reportingRateVersion.create({ data: base })).rejects.toThrow();
    await expect(
      prisma.reportingRateVersion.create({
        data: { ...base, denominator: 1n, sourceCurrency: 'JPY' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.reportingRateVersion.create({
        data: { ...base, denominator: 1n, sourceCurrency: 'USD', numerator: 2n },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.reportingRateVersion.create({
        data: { ...base, denominator: 1n, freshUntil: new Date(0) },
      }),
    ).rejects.toThrow();
  });

  it('leaves the legacy US policy immutable and unchanged when repeating international seeding', async () => {
    const config = await active('US');
    const legacy = await prisma.commercePolicyVersion.create({
      data: {
        version: 1,
        lifecycle: 'ACTIVE',
        effectiveFrom: new Date('2026-09-10Z'),
        countryCode: 'US',
        currencyCode: 'USD',
        shippingBaseMinor: 800,
        freeShippingThresholdMinor: 12000,
        heavySurchargeMinor: 400,
        heavyThresholdGrams: 2000,
        taxRateBasisPoints: 825,
        reservationDurationSeconds: 600,
        calculationVersion: 'us-usd-2026-09-10',
        priceBookVersionId: config.priceBookVersionId,
      },
    });
    await seedInternationalCommerce(prisma);
    expect(await prisma.commercePolicyVersion.findUnique({ where: { id: legacy.id } })).toEqual(
      legacy,
    );
  });
});
