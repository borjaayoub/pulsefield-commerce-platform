import type { PrismaClient } from '../generated/prisma/client';
import {
  InternationalConfigurationUnavailableError,
  resolveInternationalConfiguration,
} from './international-commerce-configuration.reader';

function fixture(now: Date) {
  const config = {
    id: 'market-config',
    version: 1,
    countryCodes: ['FR'],
    market: { code: 'EU', currencyCode: 'EUR' },
    priceBookVersion: { lifecycle: 'ACTIVE', priceBook: { marketCode: 'EU', currencyCode: 'EUR' } },
    allocationPolicyVersion: { lifecycle: 'ACTIVE', policy: { destinationRegion: 'EU' } },
    priceBookVersionId: 'prices',
    allocationPolicyVersionId: 'allocation',
    calculationVersion: 'international-commerce-v1',
    taxTreatment: 'exclusive',
    taxCalculationId: 'demo-tax-EU-v1',
    shippingCalculationId: 'demo-shipping-EU-v1',
    taxRateBasisPoints: 2000,
    shippingBaseMinor: 1000,
    freeShippingThresholdMinor: 14000,
    heavyThresholdGrams: 2000,
    heavySurchargeBasisPoints: 5000,
    reservationDurationSeconds: 600,
  };
  const rate = {
    id: 'rate',
    revision: 1,
    numerator: 11n,
    denominator: 10n,
    sourceNote: 'demo',
    effectiveFrom: new Date('2026-10-05T00:00:00Z'),
    freshUntil: new Date('2026-11-04T00:00:00Z'),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ now }]),
    commerceMarketVersion: { findMany: jest.fn().mockResolvedValue([config]) },
    reportingRateVersion: { findFirst: jest.fn().mockResolvedValue(rate) },
  };
  const transaction = jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
    callback(tx),
  );
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  return { prisma, tx, config, rate, transaction };
}

describe('international configuration read snapshot', () => {
  it.each([
    ['2026-11-03T23:59:59.999Z', false],
    ['2026-11-04T00:00:00.000Z', true],
    ['2026-11-04T00:00:00.001Z', true],
  ])('compares the PostgreSQL clock %s with the exact freshness deadline', async (time, stale) => {
    const now = new Date(time);
    const f = fixture(now);
    const result = await resolveInternationalConfiguration(f.prisma, 'FR');
    expect(result.reportingRate.staleFallback).toBe(stale);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    expect(f.tx.reportingRateVersion.findFirst).toHaveBeenCalledWith({
      where: {
        sourceCurrency: 'EUR',
        targetCurrency: 'USD',
        publishedAt: { lte: now },
        effectiveFrom: { lte: now },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
    });
    f.config.countryCodes.push('DE');
    expect(result.countryCodes).toEqual(['FR']);
  });

  it.each(['currency', 'calculation', 'routing', 'tax', 'market'])(
    'fails closed for inconsistent %s evidence',
    async (field) => {
      const f = fixture(new Date('2026-10-05Z'));
      if (field === 'currency') f.config.market.currencyCode = 'USD';
      if (field === 'calculation') f.config.calculationVersion = 'unknown';
      if (field === 'routing') f.config.allocationPolicyVersion.policy.destinationRegion = 'US';
      if (field === 'tax') f.config.taxTreatment = 'inclusive';
      if (field === 'market') f.config.market.code = 'XX';
      await expect(resolveInternationalConfiguration(f.prisma, 'FR')).rejects.toBeInstanceOf(
        InternationalConfigurationUnavailableError,
      );
      expect(f.tx.reportingRateVersion.findFirst).not.toHaveBeenCalled();
    },
  );
});
