import type { PrismaClient, Prisma } from '../src/generated/prisma/client';

const EFFECTIVE = new Date('2026-10-05T00:00:00Z');
const FRESH_UNTIL = new Date('2026-11-04T00:00:00Z');
const COUNTRIES = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'
  .split(' ')
  .sort();
const PRICES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  AERO: [4800, 48000, 4500, 4000],
  VOLT: [5600, 55000, 5200, 4600],
  STRD: [6200, 62000, 5800, 5000],
  CDNC: [6800, 68000, 6400, 5600],
  RDGE: [14800, 145000, 13900, 11900],
  SMMT: [12600, 125000, 11800, 10200],
  TRRA: [7400, 74000, 6900, 6000],
  ALPN: [9800, 98000, 9200, 8000],
  FRGE: [4400, 44000, 4100, 3600],
  VCTR: [5800, 58000, 5400, 4700],
  CORE: [7200, 72000, 6700, 5800],
  RCVR: [8800, 88000, 8200, 7100],
};
const MARKETS = [
  {
    code: 'US',
    currency: 'USD',
    countries: ['US'],
    base: 800,
    threshold: 12000,
    tax: 825,
    ratio: [1, 1],
    route: 'US-FULFILLMENT',
    warehouses: ['US-EAST-01', 'EU-CENTRAL-01', 'MA-CASA-01'],
  },
  {
    code: 'MA',
    currency: 'MAD',
    countries: ['MA'],
    base: 4500,
    threshold: 90000,
    tax: 2000,
    ratio: [1, 10],
    route: 'MA-FULFILLMENT',
    warehouses: ['MA-CASA-01', 'EU-CENTRAL-01', 'US-EAST-01'],
  },
  {
    code: 'EU',
    currency: 'EUR',
    countries: COUNTRIES,
    base: 1000,
    threshold: 14000,
    tax: 2000,
    ratio: [11, 10],
    route: 'EU-FULFILLMENT',
    warehouses: ['EU-CENTRAL-01', 'MA-CASA-01', 'US-EAST-01'],
  },
  {
    code: 'UK',
    currency: 'GBP',
    countries: ['GB'],
    base: 900,
    threshold: 12000,
    tax: 2000,
    ratio: [5, 4],
    route: 'EU-FULFILLMENT',
    warehouses: ['EU-CENTRAL-01', 'MA-CASA-01', 'US-EAST-01'],
  },
] as const;

function uuid(group: string, index: number): string {
  return `${group}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function normalized(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, part: unknown) =>
    typeof part === 'bigint' ? part.toString() : part,
  );
}

function verify(actual: object | null, expected: object): void {
  if (
    !actual ||
    Object.entries(expected).some(
      ([key, value]) => normalized(Reflect.get(actual, key)) !== normalized(value),
    )
  ) {
    throw new Error('International commerce seed fixture differs from its immutable definition.');
  }
}

async function ensureRoute(tx: Prisma.TransactionClient, index: number): Promise<string> {
  const market = MARKETS[index];
  let route = await tx.inventoryAllocationPolicy.findUnique({
    where: { code: market.route },
    include: {
      versions: {
        where: { lifecycle: 'ACTIVE' },
        include: { warehouses: { orderBy: { priority: 'asc' }, include: { warehouse: true } } },
      },
    },
  });
  if (!route && index !== 0 && index !== 3) {
    const policyId = uuid('75500000', index + 1);
    const versionId = uuid('75600000', index + 1);
    await tx.inventoryAllocationPolicy.create({
      data: { id: policyId, code: market.route, destinationRegion: index === 1 ? 'MOROCCO' : 'EU' },
    });
    await tx.inventoryAllocationPolicyVersion.create({
      data: { id: versionId, policyId, version: 1 },
    });
    const warehouses = await tx.warehouse.findMany({
      where: { code: { in: [...market.warehouses] }, status: 'ACTIVE' },
    });
    if (warehouses.length !== 3)
      throw new Error('International commerce seed requires the three demo warehouses.');
    await tx.inventoryAllocationPolicyWarehouse.createMany({
      data: market.warehouses.map((code, priority) => ({
        policyVersionId: versionId,
        warehouseId: warehouses.find((w) => w.code === code)!.id,
        priority: priority + 1,
      })),
    });
    await tx.inventoryAllocationPolicyVersion.update({
      where: { id: versionId },
      data: { lifecycle: 'ACTIVE', activatedAt: EFFECTIVE },
    });
    route = await tx.inventoryAllocationPolicy.findUnique({
      where: { id: policyId },
      include: {
        versions: {
          where: { lifecycle: 'ACTIVE' },
          include: { warehouses: { orderBy: { priority: 'asc' }, include: { warehouse: true } } },
        },
      },
    });
  }
  if (
    !route ||
    route.id !==
      (index === 0 ? uuid('74000000', 1) : uuid('75500000', index === 3 ? 3 : index + 1)) ||
    route.versions.length !== 1 ||
    route.versions[0].id !==
      (index === 0 ? uuid('74100000', 1) : uuid('75600000', index === 3 ? 3 : index + 1)) ||
    route.versions[0].version !== 1 ||
    route.destinationRegion !== (index === 0 ? 'US' : index === 1 ? 'MOROCCO' : 'EU') ||
    normalized(route.versions[0].warehouses.map((w) => w.warehouse.code)) !==
      normalized(market.warehouses)
  ) {
    throw new Error(
      'International commerce seed allocation fixture is unavailable or inconsistent.',
    );
  }
  return route.versions[0].id;
}

/** Explicit seed only. Does not mutate inventory or rewrite activated fixtures. */
export async function seedInternationalCommerce(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const variants = await tx.productVariant.findMany({
        where: { status: 'ACTIVE', product: { status: 'ACTIVE' } },
        orderBy: { sku: 'asc' },
      });
      if (variants.length !== 40 || variants.some((v) => !PRICES[v.sku.split('-')[1]]))
        throw new Error('International commerce seed requires the deterministic catalog.');
      for (let index = 0; index < MARKETS.length; index++) {
        const market = MARKETS[index];
        const marketId = uuid('75000000', index + 1);
        const existingMarket = await tx.commerceMarket.findUnique({ where: { id: marketId } });
        const identity = { id: marketId, code: market.code, currencyCode: market.currency };
        if (existingMarket) verify(existingMarket, identity);
        else await tx.commerceMarket.create({ data: identity });
        let book = await tx.priceBook.findUnique({
          where: { code: `${market.code}-RETAIL` },
          include: { versions: { where: { lifecycle: 'ACTIVE' } } },
        });
        if (!book && index > 0) {
          const bookId = uuid('75300000', index + 1);
          const versionId = uuid('75400000', index + 1);
          await tx.priceBook.create({
            data: {
              id: bookId,
              code: `${market.code}-RETAIL`,
              name: `${market.code} demo retail`,
              marketCode: market.code,
              currencyCode: market.currency,
            },
          });
          await tx.priceBookVersion.create({
            data: { id: versionId, priceBookId: bookId, version: 1 },
          });
          await tx.variantPrice.createMany({
            data: variants.map((v) => ({
              variantId: v.id,
              priceBookVersionId: versionId,
              amountMinor: BigInt(PRICES[v.sku.split('-')[1]][index]),
            })),
          });
          await tx.priceBookVersion.update({
            where: { id: versionId },
            data: { lifecycle: 'ACTIVE', effectiveFrom: EFFECTIVE, activatedAt: EFFECTIVE },
          });
          book = await tx.priceBook.findUnique({
            where: { id: bookId },
            include: { versions: { where: { lifecycle: 'ACTIVE' } } },
          });
        }
        verify(book, {
          id: index === 0 ? uuid('60000000', 1) : uuid('75300000', index + 1),
          marketCode: market.code,
          currencyCode: market.currency,
        });
        if (!book || book.versions.length !== 1)
          throw new Error('International commerce seed price fixture is unavailable.');
        const priceVersionId = book.versions[0].id;
        verify(book.versions[0], {
          id: index === 0 ? uuid('61000000', 1) : uuid('75400000', index + 1),
          version: 1,
        });
        const prices = await tx.variantPrice.findMany({
          where: { priceBookVersionId: priceVersionId },
        });
        if (prices.length !== 40)
          throw new Error('International commerce seed price coverage is inconsistent.');
        for (const variant of variants)
          verify(prices.find((p) => p.variantId === variant.id) ?? null, {
            amountMinor: BigInt(PRICES[variant.sku.split('-')[1]][index]),
          });
        const routeId = await ensureRoute(tx, index);
        const configId = uuid('75100000', index + 1);
        const data = {
          id: configId,
          marketId,
          version: 1,
          effectiveFrom: EFFECTIVE,
          countryCodes: [...market.countries],
          priceBookVersionId: priceVersionId,
          allocationPolicyVersionId: routeId,
          calculationVersion: 'international-commerce-v1',
          taxCalculationId: `demo-tax-${market.code}-v1`,
          shippingCalculationId: `demo-shipping-${market.code}-v1`,
          taxTreatment: 'exclusive',
          taxRateBasisPoints: market.tax,
          shippingBaseMinor: market.base,
          freeShippingThresholdMinor: market.threshold,
          heavyThresholdGrams: 2000,
          heavySurchargeBasisPoints: 5000,
          reservationDurationSeconds: 600,
        };
        const config = await tx.commerceMarketVersion.findUnique({ where: { id: configId } });
        if (config) verify(config, { ...data, lifecycle: 'ACTIVE' });
        else {
          await tx.commerceMarketVersion.create({ data });
          await tx.commerceMarketVersion.update({
            where: { id: configId },
            data: { lifecycle: 'ACTIVE' },
          });
        }
        const rateId = uuid('75200000', index + 1);
        const rateData = {
          id: rateId,
          sourceCurrency: market.currency,
          targetCurrency: 'USD',
          revision: 1,
          numerator: BigInt(market.ratio[0]),
          denominator: BigInt(market.ratio[1]),
          sourceNote: 'PULSE//FIELD deterministic demo reporting rates v1',
          effectiveFrom: EFFECTIVE,
          freshUntil: FRESH_UNTIL,
        };
        const rate = await tx.reportingRateVersion.findUnique({ where: { id: rateId } });
        if (rate) {
          verify(rate, rateData);
          if (!rate.publishedAt)
            throw new Error('International commerce seed rate is unpublished.');
        } else {
          await tx.reportingRateVersion.create({ data: rateData });
          await tx.reportingRateVersion.update({
            where: { id: rateId },
            data: { publishedAt: EFFECTIVE },
          });
        }
      }
    },
    { isolationLevel: 'Serializable', timeout: 30000 },
  );
}
