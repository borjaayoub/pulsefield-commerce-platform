import type {
  InternationalCommercePolicy,
  InternationalMarketCode,
  InternationalReportingRate,
  SupportedCurrency,
} from '@pulse-field/contracts';
import type { PrismaClient, Prisma } from '../generated/prisma/client';

export class InternationalConfigurationUnavailableError extends Error {
  readonly code = 'INTERNATIONAL_CONFIGURATION_UNAVAILABLE';
  constructor() {
    super('International commerce configuration is unavailable.');
  }
}

export interface ResolvedInternationalConfiguration {
  readonly market: InternationalMarketCode;
  readonly currency: SupportedCurrency;
  readonly countryCodes: readonly string[];
  readonly priceBookVersionId: string;
  readonly allocationPolicyVersionId: string;
  readonly reservationDurationSeconds: number;
  readonly policy: InternationalCommercePolicy;
  readonly reportingRate: InternationalReportingRate;
}

const MARKET_CURRENCIES = { US: 'USD', MA: 'MAD', EU: 'EUR', UK: 'GBP' } as const;

function isMarket(code: string): code is InternationalMarketCode {
  return Object.hasOwn(MARKET_CURRENCIES, code);
}

/** Standalone read-only wrapper; checkout uses the caller-owned entry point. */
export async function resolveInternationalConfiguration(
  prisma: PrismaClient,
  countryCode: string,
): Promise<ResolvedInternationalConfiguration> {
  if (typeof countryCode !== 'string' || !/^[A-Z]{2}$/u.test(countryCode))
    throw new InternationalConfigurationUnavailableError();
  try {
    return await prisma.$transaction(
      async (tx) => {
        return resolveInternationalConfigurationInTransaction(tx, countryCode);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  } catch {
    throw new InternationalConfigurationUnavailableError();
  }
}

export async function resolveInternationalConfigurationInTransaction(
  tx: Prisma.TransactionClient,
  countryCode: string,
): Promise<ResolvedInternationalConfiguration> {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  const configs = await tx.commerceMarketVersion.findMany({
    where: {
      lifecycle: 'ACTIVE',
      countryCodes: { has: countryCode },
      effectiveFrom: { lte: clock.now },
    },
    include: {
      market: true,
      priceBookVersion: { include: { priceBook: true } },
      allocationPolicyVersion: { include: { policy: true } },
    },
  });
  const config = configs[0];
  if (
    configs.length !== 1 ||
    !config ||
    !isMarket(config.market.code) ||
    MARKET_CURRENCIES[config.market.code] !== config.market.currencyCode ||
    config.calculationVersion !== 'international-commerce-v1' ||
    config.taxTreatment !== 'exclusive' ||
    config.allocationPolicyVersion.policy.destinationRegion !==
      (config.market.code === 'US' ? 'US' : config.market.code === 'MA' ? 'MOROCCO' : 'EU') ||
    config.priceBookVersion.lifecycle !== 'ACTIVE' ||
    config.allocationPolicyVersion.lifecycle !== 'ACTIVE' ||
    config.priceBookVersion.priceBook.marketCode !== config.market.code ||
    config.priceBookVersion.priceBook.currencyCode !== config.market.currencyCode
  )
    throw new InternationalConfigurationUnavailableError();
  const market = config.market.code;
  const currency = MARKET_CURRENCIES[market];
  const rate = await tx.reportingRateVersion.findFirst({
    where: {
      sourceCurrency: config.market.currencyCode,
      targetCurrency: 'USD',
      publishedAt: { lte: clock.now },
      effectiveFrom: { lte: clock.now },
    },
    orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
  });
  if (!rate) throw new InternationalConfigurationUnavailableError();
  const policy: InternationalCommercePolicy = Object.freeze({
    configurationId: config.id,
    configurationVersion: config.version,
    calculationVersion: 'international-commerce-v1',
    taxCalculationId: config.taxCalculationId,
    shippingCalculationId: config.shippingCalculationId,
    taxTreatment: 'exclusive',
    taxRateBasisPoints: config.taxRateBasisPoints,
    shippingBaseMinor: config.shippingBaseMinor,
    freeShippingThresholdMinor: config.freeShippingThresholdMinor,
    heavyThresholdGrams: config.heavyThresholdGrams,
    heavySurchargeBasisPoints: config.heavySurchargeBasisPoints,
  });
  const reportingRate: InternationalReportingRate = Object.freeze({
    revisionId: rate.id,
    revision: rate.revision,
    sourceCurrency: currency,
    targetCurrency: 'USD',
    numerator: Number(rate.numerator),
    denominator: Number(rate.denominator),
    sourceNote: rate.sourceNote,
    effectiveFrom: rate.effectiveFrom.toISOString(),
    freshUntil: rate.freshUntil.toISOString(),
    staleFallback: clock.now >= rate.freshUntil,
  });
  return Object.freeze({
    market,
    currency,
    countryCodes: Object.freeze([...config.countryCodes]),
    priceBookVersionId: config.priceBookVersionId,
    allocationPolicyVersionId: config.allocationPolicyVersionId,
    reservationDurationSeconds: config.reservationDurationSeconds,
    policy,
    reportingRate,
  });
}
