import { canAdjustCartQuantity, clampCartQuantity } from './cart-types';

describe('cart quantity controls', () => {
  it('allows reducing a priced line when availability is below its quantity', () => {
    expect(canAdjustCartQuantity({ currentUnitPriceMinor: 4800, available: 3 })).toBe(true);
  });

  it('keeps unpriced and zero-stock lines removable only', () => {
    expect(canAdjustCartQuantity({ currentUnitPriceMinor: null, available: 3 })).toBe(false);
    expect(canAdjustCartQuantity({ currentUnitPriceMinor: 4800, available: 0 })).toBe(false);
  });

  it('clamps valid quantities to one through the available bound and 99', () => {
    expect(clampCartQuantity(5, 3)).toBe(3);
    expect(clampCartQuantity(0, 3)).toBe(1);
    expect(clampCartQuantity(120, 120)).toBe(99);
    expect(clampCartQuantity(1, 0)).toBeNull();
  });
});
