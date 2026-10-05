import type { SupportedCurrency } from './index';

export type InternationalMarketCode = 'US' | 'MA' | 'EU' | 'UK';

export interface InternationalCommerceLineInput {
  readonly variantId: string;
  readonly currency: SupportedCurrency;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly weightGrams: number;
}

/** Already resolved, server-owned configuration; no configuration lookup here. */
export interface InternationalCommercePolicy {
  readonly configurationId: string;
  readonly configurationVersion: number;
  readonly calculationVersion: 'international-commerce-v1';
  readonly taxCalculationId: string;
  readonly shippingCalculationId: string;
  readonly taxTreatment: 'exclusive';
  readonly taxRateBasisPoints: number;
  readonly shippingBaseMinor: number;
  readonly freeShippingThresholdMinor: number;
  readonly heavyThresholdGrams: number;
  readonly heavySurchargeBasisPoints: number;
}

/** Selection and stale-rate fallback are the caller's responsibility. */
export interface InternationalReportingRate {
  readonly revisionId: string;
  readonly revision: number;
  readonly sourceCurrency: SupportedCurrency;
  readonly targetCurrency: 'USD';
  readonly numerator: number;
  readonly denominator: number;
  readonly sourceNote: string;
  readonly effectiveFrom: string;
  readonly freshUntil: string;
  readonly staleFallback: boolean;
}

export interface InternationalCommerceCalculationInput {
  readonly version: 1;
  readonly market: InternationalMarketCode;
  readonly currency: SupportedCurrency;
  readonly lines: readonly InternationalCommerceLineInput[];
  readonly policy: InternationalCommercePolicy;
  readonly reportingRate: InternationalReportingRate;
}

export interface InternationalCommerceCalculatedLine extends InternationalCommerceLineInput {
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

export interface InternationalCommerceCalculationResult {
  readonly version: 1;
  readonly market: InternationalMarketCode;
  readonly currency: SupportedCurrency;
  readonly lines: readonly InternationalCommerceCalculatedLine[];
  readonly policy: InternationalCommercePolicy;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly shippingMinor: number;
  readonly payableBaseShippingMinor: number;
  readonly heavySurchargeMinor: number;
  readonly totalMinor: number;
  readonly totalWeightGrams: number;
  readonly reporting: {
    readonly calculationVersion: 'usd-reporting-v1';
    readonly currency: 'USD';
    readonly rate: InternationalReportingRate;
    readonly subtotalMinor: number;
    readonly taxMinor: number;
    readonly shippingMinor: number;
    readonly totalMinor: number;
    readonly roundingAdjustmentMinor: number;
  };
}
