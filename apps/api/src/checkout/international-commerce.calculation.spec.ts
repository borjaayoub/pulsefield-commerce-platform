import type {
  InternationalCommerceCalculationInput,
  InternationalMarketCode,
  SupportedCurrency,
} from '@pulse-field/contracts';
import {
  calculateInternationalCommerce,
  InternationalCommerceCalculationError,
} from './international-commerce.calculation';
import { calculateUsdCheckoutTotals } from './checkout.service';

function fixture(
  overrides: Partial<InternationalCommerceCalculationInput> = {},
): InternationalCommerceCalculationInput {
  return {
    version: 1,
    market: 'US',
    currency: 'USD',
    lines: [
      { variantId: 'aero', currency: 'USD', quantity: 2, unitPriceMinor: 4800, weightGrams: 145 },
    ],
    policy: {
      configurationId: 'demo-us-v1',
      configurationVersion: 1,
      calculationVersion: 'international-commerce-v1',
      taxCalculationId: 'demo-tax-us-v1',
      shippingCalculationId: 'demo-shipping-us-v1',
      taxTreatment: 'exclusive',
      taxRateBasisPoints: 825,
      shippingBaseMinor: 800,
      freeShippingThresholdMinor: 12000,
      heavyThresholdGrams: 2000,
      heavySurchargeBasisPoints: 5000,
    },
    reportingRate: {
      revisionId: 'demo-usd-v1',
      revision: 1,
      sourceCurrency: 'USD',
      targetCurrency: 'USD',
      numerator: 1,
      denominator: 1,
      sourceNote: 'PULSE//FIELD deterministic demo reporting rates v1',
      effectiveFrom: '2026-10-05T00:00:00Z',
      freshUntil: '2026-11-04T00:00:00Z',
      staleFallback: false,
    },
    ...overrides,
  };
}

const markets: Array<{
  market: InternationalMarketCode;
  currency: SupportedCurrency;
  unit: number;
  tax: number;
  base: number;
  threshold: number;
  numerator: number;
  denominator: number;
  expected: [number, number, number, number, number];
}> = [
  {
    market: 'US',
    currency: 'USD',
    unit: 4800,
    tax: 825,
    base: 800,
    threshold: 12000,
    numerator: 1,
    denominator: 1,
    expected: [9600, 792, 800, 11192, 11192],
  },
  {
    market: 'MA',
    currency: 'MAD',
    unit: 48000,
    tax: 2000,
    base: 4500,
    threshold: 90000,
    numerator: 1,
    denominator: 10,
    expected: [96000, 19200, 0, 115200, 11520],
  },
  {
    market: 'EU',
    currency: 'EUR',
    unit: 4500,
    tax: 2000,
    base: 1000,
    threshold: 14000,
    numerator: 11,
    denominator: 10,
    expected: [9000, 1800, 1000, 11800, 12980],
  },
  {
    market: 'UK',
    currency: 'GBP',
    unit: 4000,
    tax: 2000,
    base: 900,
    threshold: 12000,
    numerator: 5,
    denominator: 4,
    expected: [8000, 1600, 900, 10500, 13125],
  },
];

describe('international commerce calculation', () => {
  it.each(markets)('reconciles the approved two-tee $market example', (market) => {
    const original = fixture();
    const result = calculateInternationalCommerce(
      fixture({
        market: market.market,
        currency: market.currency,
        lines: [{ ...original.lines[0], currency: market.currency, unitPriceMinor: market.unit }],
        policy: {
          ...original.policy,
          taxRateBasisPoints: market.tax,
          shippingBaseMinor: market.base,
          freeShippingThresholdMinor: market.threshold,
        },
        reportingRate: {
          ...original.reportingRate,
          sourceCurrency: market.currency,
          numerator: market.numerator,
          denominator: market.denominator,
        },
      }),
    );
    expect([
      result.subtotalMinor,
      result.taxMinor,
      result.shippingMinor,
      result.totalMinor,
      result.reporting.totalMinor,
    ]).toEqual(market.expected);
    expect(result.totalWeightGrams).toBe(290);
    expect(result.lines[0].totalMinor).toBe(result.subtotalMinor + result.taxMinor);
    expect(result.totalMinor).toBe(result.subtotalMinor + result.taxMinor + result.shippingMinor);
    expect(result.reporting.totalMinor).toBe(
      result.reporting.subtotalMinor +
        result.reporting.taxMinor +
        result.reporting.shippingMinor +
        result.reporting.roundingAdjustmentMinor,
    );
  });

  it.each([
    [11999, 1999, 800, 0],
    [11999, 2000, 800, 0],
    [11999, 2001, 1200, 400],
    [12000, 1999, 0, 0],
    [12000, 2000, 0, 0],
    [12000, 2001, 400, 400],
  ])(
    'prices subtotal %i and weight %i at the exact shipping boundaries',
    (subtotal, weight, shipping, surcharge) => {
      const original = fixture();
      const result = calculateInternationalCommerce(
        fixture({
          lines: [
            { ...original.lines[0], quantity: 1, unitPriceMinor: subtotal, weightGrams: weight },
          ],
        }),
      );
      expect(result.shippingMinor).toBe(shipping);
      expect(result.heavySurchargeMinor).toBe(surcharge);
      expect(result.payableBaseShippingMinor).toBe(shipping - surcharge);
    },
  );

  it('rounds the surcharge half upwards from the configured base, even when waived', () => {
    const original = fixture();
    const result = calculateInternationalCommerce(
      fixture({
        lines: [{ ...original.lines[0], weightGrams: 1001 }],
        policy: { ...original.policy, shippingBaseMinor: 9, freeShippingThresholdMinor: 0 },
      }),
    );
    expect(result.payableBaseShippingMinor).toBe(0);
    expect(result.heavySurchargeMinor).toBe(5);
    expect(result.shippingMinor).toBe(5);
  });

  it('rounds once per complete variant line and sums line taxes', () => {
    const original = fixture();
    const result = calculateInternationalCommerce(
      fixture({
        lines: [
          { ...original.lines[0], quantity: 2, unitPriceMinor: 3 },
          { ...original.lines[0], variantId: 'volt', quantity: 1, unitPriceMinor: 6 },
          { ...original.lines[0], variantId: 'stride', quantity: 2, unitPriceMinor: 5 },
        ],
      }),
    );
    expect(result.lines.map((line) => line.taxMinor)).toEqual([0, 0, 1]);
    expect(result.taxMinor).toBe(1);
    expect(result.shippingMinor).toBe(800);
  });

  it('rounds an exact half of one minor unit upwards', () => {
    const original = fixture();
    const result = calculateInternationalCommerce(
      fixture({
        lines: [{ ...original.lines[0], quantity: 1, unitPriceMinor: 5 }],
        policy: { ...original.policy, taxRateBasisPoints: 1000 },
      }),
    );
    expect(result.taxMinor).toBe(1);
  });

  it.each([
    [1, 2, -1, 2],
    [5, 4, 1, 4],
    [1, 3, 1, 1],
  ])(
    'preserves a signed reporting adjustment at ratio %i/%i',
    (numerator, denominator, adjustment, total) => {
      const original = fixture();
      const result = calculateInternationalCommerce(
        fixture({
          market: 'EU',
          currency: 'EUR',
          lines: [{ ...original.lines[0], currency: 'EUR', quantity: 1, unitPriceMinor: 1 }],
          policy: { ...original.policy, taxRateBasisPoints: 10000, shippingBaseMinor: 1 },
          reportingRate: {
            ...original.reportingRate,
            sourceCurrency: 'EUR',
            numerator,
            denominator,
          },
        }),
      );
      expect(result.totalMinor).toBe(3);
      expect(result.reporting.totalMinor).toBe(total);
      expect(result.reporting.roundingAdjustmentMinor).toBe(adjustment);
    },
  );

  it('changing the reporting rate changes only reporting values', () => {
    const original = fixture();
    const input = fixture({
      market: 'EU',
      currency: 'EUR',
      lines: [{ ...original.lines[0], currency: 'EUR' }],
      reportingRate: { ...original.reportingRate, sourceCurrency: 'EUR' },
    });
    const first = calculateInternationalCommerce(input);
    const second = calculateInternationalCommerce({
      ...input,
      reportingRate: { ...input.reportingRate, numerator: 3, denominator: 2, staleFallback: true },
    });
    expect({ ...second, reporting: first.reporting }).toEqual(first);
    expect(second.reporting.totalMinor).not.toBe(first.reporting.totalMinor);
    expect(second.reporting.rate.staleFallback).toBe(true);
  });

  it.each(markets)('retains the $market heavy surcharge at the free threshold', (market) => {
    const original = fixture();
    const totals = { US: 13390, MA: 110250, EU: 17300, UK: 14850 };
    const result = calculateInternationalCommerce(
      fixture({
        market: market.market,
        currency: market.currency,
        lines: [
          {
            ...original.lines[0],
            currency: market.currency,
            quantity: 1,
            unitPriceMinor: market.threshold,
            weightGrams: 2001,
          },
        ],
        policy: {
          ...original.policy,
          taxRateBasisPoints: market.tax,
          shippingBaseMinor: market.base,
          freeShippingThresholdMinor: market.threshold,
        },
        reportingRate: {
          ...original.reportingRate,
          sourceCurrency: market.currency,
          numerator: market.numerator,
          denominator: market.denominator,
        },
      }),
    );
    expect(result.payableBaseShippingMinor).toBe(0);
    expect(result.shippingMinor).toBe(market.base / 2);
    expect(result.totalMinor).toBe(totals[market.market]);
  });

  it('keeps one order charge independent of auxiliary single or split allocation plans', () => {
    const input = fixture();
    const singlePlan = {
      ...input,
      allocations: [{ warehouse: 'US-EAST-01', variantId: 'aero', quantity: 2 }],
    };
    const splitPlan = {
      ...input,
      allocations: [
        { warehouse: 'US-EAST-01', variantId: 'aero', quantity: 1 },
        { warehouse: 'EU-CENTRAL-01', variantId: 'aero', quantity: 1 },
      ],
    };
    const single = calculateInternationalCommerce(singlePlan);
    const split = calculateInternationalCommerce(splitPlan);
    expect(split).toEqual(single);
    expect(split.shippingMinor).toBe(800);
    expect(split.taxMinor).toBe(792);
    expect(split).not.toHaveProperty('allocations');
  });

  it('uses exact bigint intermediates where floating point would lose a reporting half', () => {
    const original = fixture();
    const result = calculateInternationalCommerce(
      fixture({
        market: 'EU',
        currency: 'EUR',
        lines: [
          {
            ...original.lines[0],
            currency: 'EUR',
            quantity: 1,
            unitPriceMinor: Number.MAX_SAFE_INTEGER,
            weightGrams: 0,
          },
        ],
        policy: { ...original.policy, taxRateBasisPoints: 0, freeShippingThresholdMinor: 0 },
        reportingRate: {
          ...original.reportingRate,
          sourceCurrency: 'EUR',
          numerator: 1,
          denominator: 2,
        },
      }),
    );
    expect(result.totalMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.reporting.totalMinor).toBe(4503599627370496);
  });

  it('copies declared evidence and freezes all returned objects without freezing inputs', () => {
    const original = fixture();
    const policy = { ...original.policy, unexpected: 'discard-me' };
    const reportingRate = { ...original.reportingRate, unexpected: 'discard-me' };
    const line = { ...original.lines[0], unexpected: 'discard-me' };
    const input = fixture({ policy, reportingRate, lines: [line] });
    const result = calculateInternationalCommerce(input);
    policy.taxRateBasisPoints = 0;
    reportingRate.sourceNote = 'changed';
    line.unitPriceMinor = 1;
    expect(result.taxMinor).toBe(792);
    expect(result.policy.taxRateBasisPoints).toBe(825);
    expect(result.reporting.rate.sourceNote).toBe(original.reportingRate.sourceNote);
    expect(JSON.stringify(result)).not.toContain('discard-me');
    for (const value of [
      result,
      result.lines,
      result.lines[0],
      result.policy,
      result.reporting,
      result.reporting.rate,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(result.policy, 'taxRateBasisPoints', 1)).toBe(false);
    expect(Object.isFrozen(policy)).toBe(false);
  });

  it.each([
    [0, 0, 1],
    [100, 1999, 1],
    [11999, 2000, 1],
    [12000, 2001, 1],
    [4800, 145, 2],
    [999, 750, 3],
    [1000000, 5000, 10],
  ])(
    'matches the existing US calculator for unit price %i, weight %i, quantity %i',
    (price, weight, quantity) => {
      const original = fixture();
      const lines = [
        { ...original.lines[0], unitPriceMinor: price, weightGrams: weight, quantity },
      ];
      const current = calculateUsdCheckoutTotals(lines, {
        ...original.policy,
        heavySurchargeMinor: 400,
      });
      const next = calculateInternationalCommerce(fixture({ lines }));
      expect({
        subtotalMinor: next.subtotalMinor,
        taxMinor: next.taxMinor,
        shippingMinor: next.shippingMinor,
        totalMinor: next.totalMinor,
        totalWeightGrams: next.totalWeightGrams,
      }).toEqual({
        subtotalMinor: current.subtotalMinor,
        taxMinor: current.taxMinor,
        shippingMinor: current.shippingMinor,
        totalMinor: current.totalMinor,
        totalWeightGrams: current.totalWeightGrams,
      });
      expect(
        next.lines.map(({ variantId, quantity: q, unitPriceMinor, subtotalMinor, taxMinor }) => ({
          variantId,
          quantity: q,
          unitPriceMinor,
          subtotalMinor,
          taxMinor,
        })),
      ).toEqual(current.lines);
    },
  );

  const invalidInputs: Array<[string, (input: InternationalCommerceCalculationInput) => unknown]> =
    [
      ['unknown version', (input) => ({ ...input, version: 2 })],
      ['unsupported market', (input) => ({ ...input, market: 'constructor' })],
      ['unsupported currency', (input) => ({ ...input, currency: 'JPY' })],
      ['wrong market currency', (input) => ({ ...input, market: 'EU' })],
      [
        'mixed line currencies',
        (input) => ({ ...input, lines: [{ ...input.lines[0], currency: 'EUR' }] }),
      ],
      ['empty basket', (input) => ({ ...input, lines: [] })],
      ['sparse basket', (input) => ({ ...input, lines: Array(1) })],
      [
        'duplicate variant lines',
        (input) => ({ ...input, lines: [input.lines[0], input.lines[0]] }),
      ],
      ['null line', (input) => ({ ...input, lines: [null] })],
      ['zero quantity', (input) => ({ ...input, lines: [{ ...input.lines[0], quantity: 0 }] })],
      [
        'fractional quantity',
        (input) => ({ ...input, lines: [{ ...input.lines[0], quantity: 1.5 }] }),
      ],
      [
        'negative price',
        (input) => ({ ...input, lines: [{ ...input.lines[0], unitPriceMinor: -1 }] }),
      ],
      ['NaN weight', (input) => ({ ...input, lines: [{ ...input.lines[0], weightGrams: NaN }] })],
      [
        'unsafe quantity',
        (input) => ({
          ...input,
          lines: [{ ...input.lines[0], quantity: Number.MAX_SAFE_INTEGER + 1 }],
        }),
      ],
      [
        'tax above 100 percent',
        (input) => ({ ...input, policy: { ...input.policy, taxRateBasisPoints: 10001 } }),
      ],
      [
        'inclusive tax',
        (input) => ({ ...input, policy: { ...input.policy, taxTreatment: 'inclusive' } }),
      ],
      [
        'unknown algorithm',
        (input) => ({ ...input, policy: { ...input.policy, calculationVersion: 'v2' } }),
      ],
      [
        'negative shipping',
        (input) => ({ ...input, policy: { ...input.policy, shippingBaseMinor: -1 } }),
      ],
      [
        'negative threshold',
        (input) => ({ ...input, policy: { ...input.policy, freeShippingThresholdMinor: -1 } }),
      ],
      [
        'negative weight threshold',
        (input) => ({ ...input, policy: { ...input.policy, heavyThresholdGrams: -1 } }),
      ],
      [
        'invalid surcharge',
        (input) => ({ ...input, policy: { ...input.policy, heavySurchargeBasisPoints: 10001 } }),
      ],
      [
        'invalid config revision',
        (input) => ({ ...input, policy: { ...input.policy, configurationVersion: 0 } }),
      ],
      [
        'unsafe evidence identifier',
        (input) => ({ ...input, policy: { ...input.policy, taxCalculationId: 'secret\nvalue' } }),
      ],
      [
        'wrong source currency',
        (input) => ({ ...input, reportingRate: { ...input.reportingRate, sourceCurrency: 'EUR' } }),
      ],
      [
        'wrong target currency',
        (input) => ({ ...input, reportingRate: { ...input.reportingRate, targetCurrency: 'GBP' } }),
      ],
      [
        'zero numerator',
        (input) => ({ ...input, reportingRate: { ...input.reportingRate, numerator: 0 } }),
      ],
      [
        'zero denominator',
        (input) => ({ ...input, reportingRate: { ...input.reportingRate, denominator: 0 } }),
      ],
      [
        'fractional denominator',
        (input) => ({ ...input, reportingRate: { ...input.reportingRate, denominator: 1.5 } }),
      ],
      [
        'nonidentity USD reporting',
        (input) => ({ ...input, reportingRate: { ...input.reportingRate, numerator: 2 } }),
      ],
      [
        'invalid rate revision',
        (input) => ({ ...input, reportingRate: { ...input.reportingRate, revision: 0 } }),
      ],
      [
        'invalid fallback flag',
        (input) => ({ ...input, reportingRate: { ...input.reportingRate, staleFallback: 'true' } }),
      ],
      [
        'invalid timestamp',
        (input) => ({
          ...input,
          reportingRate: { ...input.reportingRate, effectiveFrom: '2026-02-30T00:00:00Z' },
        }),
      ],
      [
        'reversed freshness',
        (input) => ({
          ...input,
          reportingRate: { ...input.reportingRate, freshUntil: '2026-10-04T00:00:00Z' },
        }),
      ],
      [
        'missing source note',
        (input) => ({ ...input, reportingRate: { ...input.reportingRate, sourceNote: '' } }),
      ],
      [
        'unsafe line subtotal',
        (input) => ({
          ...input,
          lines: [{ ...input.lines[0], unitPriceMinor: Number.MAX_SAFE_INTEGER }],
        }),
      ],
      [
        'unsafe total weight',
        (input) => ({
          ...input,
          lines: [{ ...input.lines[0], weightGrams: Number.MAX_SAFE_INTEGER }],
        }),
      ],
      [
        'unsafe reporting result',
        (input) => ({
          ...input,
          market: 'EU',
          currency: 'EUR',
          lines: [{ ...input.lines[0], currency: 'EUR' }],
          reportingRate: {
            ...input.reportingRate,
            sourceCurrency: 'EUR',
            numerator: Number.MAX_SAFE_INTEGER,
          },
        }),
      ],
      ['missing policy', (input) => ({ ...input, policy: null })],
      ['missing rate', (input) => ({ ...input, reportingRate: null })],
      ['null input', () => null],
    ];

  it.each(invalidInputs)('rejects %s with a fixed redacted error', (_name, corrupt) => {
    expect(() =>
      calculateInternationalCommerce(corrupt(fixture()) as InternationalCommerceCalculationInput),
    ).toThrow(InternationalCommerceCalculationError);
    expect(() =>
      calculateInternationalCommerce(corrupt(fixture()) as InternationalCommerceCalculationInput),
    ).toThrow('International commerce calculation inputs or results are invalid.');
  });
});
