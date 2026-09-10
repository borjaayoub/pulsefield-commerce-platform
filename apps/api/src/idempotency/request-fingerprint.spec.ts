import { InvalidIdempotencyInputError } from './idempotency.errors';
import { fingerprintIdempotentRequest } from './request-fingerprint';

describe('fingerprintIdempotentRequest', () => {
  it('produces the same fingerprint regardless of object key order', () => {
    expect(
      fingerprintIdempotentRequest('checkout.create', {
        quantity: 2,
        lines: [{ sku: 'shoe-blue-42', warehouse: 'casablanca' }],
      }),
    ).toBe(
      fingerprintIdempotentRequest('checkout.create', {
        lines: [{ warehouse: 'casablanca', sku: 'shoe-blue-42' }],
        quantity: 2,
      }),
    );
  });

  it('changes when the operation or meaningful input changes', () => {
    const input = { reservationId: 'reservation-123' };
    expect(fingerprintIdempotentRequest('inventory.commit', input)).not.toBe(
      fingerprintIdempotentRequest('inventory.release', input),
    );
    expect(fingerprintIdempotentRequest('inventory.commit', input)).not.toBe(
      fingerprintIdempotentRequest('inventory.commit', { reservationId: 'reservation-456' }),
    );
  });

  it.each([
    { password: 'never-hash-this' },
    { nested: { authorization: 'Bearer secret' } },
    { amount: Number.NaN },
    { createdAt: new Date() },
    { optional: undefined },
  ])('rejects unsafe or non-canonical input %#', (input) => {
    expect(() => fingerprintIdempotentRequest('checkout.create', input)).toThrow(
      InvalidIdempotencyInputError,
    );
  });
});
