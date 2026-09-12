import {
  CHECKOUT_RETRY_DELAYS_MS,
  calculateUsdCheckoutTotals,
  CheckoutService,
  isRetryableTransactionError,
  roundHalfUp,
  toIdempotencyShippingAddress,
  withCheckoutTransactionRetry,
} from './checkout.service';
import { CheckoutConflictError } from './checkout.errors';
import { plainToInstance } from 'class-transformer';
import { fingerprintIdempotentRequest } from '../idempotency/request-fingerprint';
import { CreateCheckoutDto } from './checkout.dto';

const POLICY = {
  shippingBaseMinor: 800,
  freeShippingThresholdMinor: 12_000,
  heavySurchargeMinor: 400,
  heavyThresholdGrams: 2_000,
  taxRateBasisPoints: 825,
};

describe('Phase 3 US/USD checkout calculation', () => {
  it('projects a transformed checkout address to a plain safe idempotency input', () => {
    const dto = plainToInstance(CreateCheckoutDto, {
      shippingAddress: {
        fullName: 'Demo Person',
        line1: '1 Test Street',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        countryCode: 'US',
        providerToken: 'must-not-fingerprint',
      },
      pricingFingerprint: 'a'.repeat(16),
      paymentMethodReference: 'stub-success',
    });
    const address = toIdempotencyShippingAddress(dto.shippingAddress);
    expect(Object.getPrototypeOf(address)).toBe(Object.prototype);
    expect(address).toEqual({
      fullName: 'Demo Person',
      line1: '1 Test Street',
      line2: '',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      countryCode: 'US',
    });
    expect(() =>
      fingerprintIdempotentRequest('checkout.create', { shippingAddress: address }),
    ).not.toThrow();
    expect(JSON.stringify(address)).not.toContain('providerToken');
  });

  it('passes the plain address projection into the checkout idempotency command', async () => {
    const begin = jest.fn().mockRejectedValue(new Error('captured before persistence'));
    const service = new CheckoutService(
      { cart: { findUnique: jest.fn().mockResolvedValue({ id: 'cart-1' }) } } as never,
      { begin } as never,
      {} as never,
      {} as never,
    );
    const dto = plainToInstance(CreateCheckoutDto, {
      shippingAddress: {
        fullName: 'Demo Person',
        line1: '1 Test Street',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        countryCode: 'US',
        providerToken: 'must-not-fingerprint',
      },
      pricingFingerprint: 'a'.repeat(16),
      paymentMethodReference: 'stub-success',
    });
    await expect(
      service.create('cart-token', 1, 'idempotency-key', dto, 'request-1'),
    ).rejects.toThrow('captured before persistence');
    const capturedAddress = begin.mock.calls[0][0].request.shippingAddress;
    expect(Object.getPrototypeOf(capturedAddress)).toBe(Object.prototype);
    expect(capturedAddress).toEqual({
      fullName: 'Demo Person',
      line1: '1 Test Street',
      line2: '',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      countryCode: 'US',
    });
  });

  it('rounds simulated tax half-up per order line before summing', () => {
    expect(roundHalfUp(50, 100)).toBe(1);
    expect(
      calculateUsdCheckoutTotals(
        [
          { variantId: 'a', quantity: 1, unitPriceMinor: 200, weightGrams: 100 },
          { variantId: 'b', quantity: 1, unitPriceMinor: 200, weightGrams: 100 },
        ],
        POLICY,
      ),
    ).toMatchObject({ taxMinor: 34, shippingMinor: 800, totalMinor: 1234 });
  });

  it('removes only base shipping at the threshold and retains the heavy surcharge', () => {
    expect(
      calculateUsdCheckoutTotals(
        [{ variantId: 'a', quantity: 1, unitPriceMinor: 12000, weightGrams: 2001 }],
        POLICY,
      ),
    ).toMatchObject({ subtotalMinor: 12000, shippingMinor: 400, taxMinor: 990, totalMinor: 13390 });
  });

  it('keeps standard shipping below the free threshold', () => {
    expect(
      calculateUsdCheckoutTotals(
        [{ variantId: 'a', quantity: 1, unitPriceMinor: 11999, weightGrams: 2000 }],
        POLICY,
      ).shippingMinor,
    ).toBe(800);
  });

  it('rejects unsafe line multiplication instead of losing money precision', () => {
    expect(() =>
      calculateUsdCheckoutTotals(
        [
          {
            variantId: 'unsafe',
            quantity: 2,
            unitPriceMinor: Number.MAX_SAFE_INTEGER,
            weightGrams: 0,
          },
        ],
        { ...POLICY, taxRateBasisPoints: 0 },
      ),
    ).toThrow(CheckoutConflictError);
  });

  it('rejects unsafe tax multiplication and weight accumulation', () => {
    expect(() =>
      calculateUsdCheckoutTotals(
        [
          {
            variantId: 'unsafe-tax',
            quantity: 1,
            unitPriceMinor: Number.MAX_SAFE_INTEGER,
            weightGrams: 0,
          },
        ],
        { ...POLICY, taxRateBasisPoints: 10_000 },
      ),
    ).toThrow(CheckoutConflictError);
    expect(() =>
      calculateUsdCheckoutTotals(
        [
          {
            variantId: 'unsafe-weight',
            quantity: 2,
            unitPriceMinor: 0,
            weightGrams: Number.MAX_SAFE_INTEGER,
          },
        ],
        { ...POLICY, taxRateBasisPoints: 0 },
      ),
    ).toThrow(CheckoutConflictError);
  });

  it('rejects unsafe subtotal and total/shipping accumulation', () => {
    expect(() =>
      calculateUsdCheckoutTotals(
        [
          {
            variantId: 'subtotal-a',
            quantity: 1,
            unitPriceMinor: Number.MAX_SAFE_INTEGER,
            weightGrams: 0,
          },
          {
            variantId: 'subtotal-b',
            quantity: 1,
            unitPriceMinor: Number.MAX_SAFE_INTEGER,
            weightGrams: 0,
          },
        ],
        { ...POLICY, taxRateBasisPoints: 0, freeShippingThresholdMinor: Number.MAX_SAFE_INTEGER },
      ),
    ).toThrow(CheckoutConflictError);
    expect(() =>
      calculateUsdCheckoutTotals(
        [{ variantId: 'total', quantity: 1, unitPriceMinor: 1, weightGrams: 0 }],
        {
          ...POLICY,
          taxRateBasisPoints: 0,
          shippingBaseMinor: Number.MAX_SAFE_INTEGER,
          freeShippingThresholdMinor: Number.MAX_SAFE_INTEGER,
        },
      ),
    ).toThrow(CheckoutConflictError);
  });

  it('recognizes Prisma and PostgreSQL transaction-retry shapes', () => {
    expect(isRetryableTransactionError({ code: 'P2034' })).toBe(true);
    expect(isRetryableTransactionError({ cause: { sqlState: '40001' } })).toBe(true);
    expect(isRetryableTransactionError({ code: '40P01' })).toBe(true);
    expect(isRetryableTransactionError({ code: 'P2002' })).toBe(false);
  });

  it('makes at most three attempts with the bounded transaction retry schedule', async () => {
    expect(CHECKOUT_RETRY_DELAYS_MS).toEqual([0, 10, 25]);
    const error = Object.assign(new Error('serialization failure'), { code: 'P2034' });
    let attempts = 0;
    await expect(
      withCheckoutTransactionRetry(async () => {
        attempts += 1;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(3);
  });
});
