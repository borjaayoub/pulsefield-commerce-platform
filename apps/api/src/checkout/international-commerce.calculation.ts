import type {
  InternationalCommerceCalculationInput,
  InternationalCommerceCalculationResult,
  InternationalCommercePolicy,
  InternationalMarketCode,
  InternationalReportingRate,
  SupportedCurrency,
} from '@pulse-field/contracts';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const BASIS_POINTS = 10_000n;
const MARKET_CURRENCY: Readonly<Record<InternationalMarketCode, SupportedCurrency>> = {
  US: 'USD',
  MA: 'MAD',
  EU: 'EUR',
  UK: 'GBP',
};

export class InternationalCommerceCalculationError extends Error {
  readonly code = 'INVALID_INTERNATIONAL_COMMERCE_CALCULATION';

  constructor() {
    super('International commerce calculation inputs or results are invalid.');
  }
}

function invalid(): never {
  throw new InternationalCommerceCalculationError();
}

function integer(value: number, positive = false): bigint {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) invalid();
  return BigInt(value);
}

function basisPoints(value: number): bigint {
  const result = integer(value);
  if (result > BASIS_POINTS) invalid();
  return result;
}

function safeNumber(value: bigint, signed = false): number {
  if (value > MAX_SAFE || value < (signed ? -MAX_SAFE : 0n)) invalid();
  return Number(value);
}

function halfUp(numerator: bigint, denominator: bigint): bigint {
  // Exact for even and odd denominators; all callers supply nonnegative values.
  return (2n * numerator + denominator) / (2n * denominator);
}

function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) invalid();
  return value;
}

function timestamp(value: string): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  )
    invalid();
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== value.replace(/Z$/u, value.includes('.') ? 'Z' : '.000Z')
  )
    invalid();
  return time;
}

function snapshotPolicy(policy: InternationalCommercePolicy): InternationalCommercePolicy {
  if (
    !policy ||
    policy.calculationVersion !== 'international-commerce-v1' ||
    policy.taxTreatment !== 'exclusive'
  )
    invalid();
  integer(policy.configurationVersion, true);
  basisPoints(policy.taxRateBasisPoints);
  integer(policy.shippingBaseMinor);
  integer(policy.freeShippingThresholdMinor);
  integer(policy.heavyThresholdGrams);
  basisPoints(policy.heavySurchargeBasisPoints);
  return Object.freeze({
    configurationId: identifier(policy.configurationId),
    configurationVersion: policy.configurationVersion,
    calculationVersion: policy.calculationVersion,
    taxCalculationId: identifier(policy.taxCalculationId),
    shippingCalculationId: identifier(policy.shippingCalculationId),
    taxTreatment: policy.taxTreatment,
    taxRateBasisPoints: policy.taxRateBasisPoints,
    shippingBaseMinor: policy.shippingBaseMinor,
    freeShippingThresholdMinor: policy.freeShippingThresholdMinor,
    heavyThresholdGrams: policy.heavyThresholdGrams,
    heavySurchargeBasisPoints: policy.heavySurchargeBasisPoints,
  });
}

function snapshotRate(
  rate: InternationalReportingRate,
  currency: SupportedCurrency,
): InternationalReportingRate {
  if (
    !rate ||
    rate.sourceCurrency !== currency ||
    rate.targetCurrency !== 'USD' ||
    typeof rate.staleFallback !== 'boolean'
  )
    invalid();
  integer(rate.revision, true);
  integer(rate.numerator, true);
  integer(rate.denominator, true);
  if (currency === 'USD' && rate.numerator !== rate.denominator) invalid();
  if (
    typeof rate.sourceNote !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9 /._:-]{0,159}$/u.test(rate.sourceNote)
  )
    invalid();
  if (timestamp(rate.freshUntil) <= timestamp(rate.effectiveFrom)) invalid();
  return Object.freeze({
    revisionId: identifier(rate.revisionId),
    revision: rate.revision,
    sourceCurrency: rate.sourceCurrency,
    targetCurrency: rate.targetCurrency,
    numerator: rate.numerator,
    denominator: rate.denominator,
    sourceNote: rate.sourceNote,
    effectiveFrom: rate.effectiveFrom,
    freshUntil: rate.freshUntil,
    staleFallback: rate.staleFallback,
  });
}

/** Pure arithmetic on resolved inputs. Does not authorize, select or persist them. */
export function calculateInternationalCommerce(
  input: InternationalCommerceCalculationInput,
): InternationalCommerceCalculationResult {
  if (
    !input ||
    input.version !== 1 ||
    !Object.hasOwn(MARKET_CURRENCY, input.market) ||
    MARKET_CURRENCY[input.market] !== input.currency ||
    !Array.isArray(input.lines) ||
    input.lines.length === 0
  )
    invalid();
  const policy = snapshotPolicy(input.policy);
  const rate = snapshotRate(input.reportingRate, input.currency);
  const variants = new Set<string>();
  let subtotal = 0n;
  let tax = 0n;
  let weight = 0n;
  const lines = input.lines.map((line) => {
    if (!line || line.currency !== input.currency) invalid();
    const variantId = identifier(line.variantId);
    if (variants.has(variantId)) invalid();
    variants.add(variantId);
    const quantity = integer(line.quantity, true);
    const lineSubtotal = integer(line.unitPriceMinor) * quantity;
    const lineTax = halfUp(lineSubtotal * BigInt(policy.taxRateBasisPoints), BASIS_POINTS);
    subtotal += lineSubtotal;
    tax += lineTax;
    weight += integer(line.weightGrams) * quantity;
    return Object.freeze({
      variantId,
      currency: input.currency,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      weightGrams: line.weightGrams,
      subtotalMinor: safeNumber(lineSubtotal),
      taxMinor: safeNumber(lineTax),
      totalMinor: safeNumber(lineSubtotal + lineTax),
    });
  });
  if (variants.size !== input.lines.length) invalid();
  const base =
    subtotal >= BigInt(policy.freeShippingThresholdMinor) ? 0n : BigInt(policy.shippingBaseMinor);
  const surcharge =
    weight > BigInt(policy.heavyThresholdGrams)
      ? halfUp(
          BigInt(policy.shippingBaseMinor) * BigInt(policy.heavySurchargeBasisPoints),
          BASIS_POINTS,
        )
      : 0n;
  const shipping = base + surcharge;
  const total = subtotal + tax + shipping;
  const convert = (amount: bigint): bigint =>
    halfUp(amount * BigInt(rate.numerator), BigInt(rate.denominator));
  const reportingSubtotal = convert(subtotal);
  const reportingTax = convert(tax);
  const reportingShipping = convert(shipping);
  const reportingTotal = convert(total);
  return Object.freeze({
    version: 1,
    market: input.market,
    currency: input.currency,
    lines: Object.freeze(lines),
    policy,
    subtotalMinor: safeNumber(subtotal),
    taxMinor: safeNumber(tax),
    shippingMinor: safeNumber(shipping),
    payableBaseShippingMinor: safeNumber(base),
    heavySurchargeMinor: safeNumber(surcharge),
    totalMinor: safeNumber(total),
    totalWeightGrams: safeNumber(weight),
    reporting: Object.freeze({
      calculationVersion: 'usd-reporting-v1',
      currency: 'USD',
      rate,
      subtotalMinor: safeNumber(reportingSubtotal),
      taxMinor: safeNumber(reportingTax),
      shippingMinor: safeNumber(reportingShipping),
      totalMinor: safeNumber(reportingTotal),
      roundingAdjustmentMinor: safeNumber(
        reportingTotal - reportingSubtotal - reportingTax - reportingShipping,
        true,
      ),
    }),
  });
}
