import { accessTokenFromFragment, guestOrderSessionKey } from './order-timeline';

describe('guest order access fragment', () => {
  it('reads the credential from a fragment without putting it in a request URL', () => {
    expect(accessTokenFromFragment('#access=grant.signature')).toBe('grant.signature');
  });

  it('uses an order-scoped same-origin redirect handoff key', () => {
    expect(guestOrderSessionKey('PF-TEST0001')).toBe('pulse-field:guest-order:PF-TEST0001');
  });

  it('rejects missing and oversized credentials', () => {
    expect(accessTokenFromFragment('')).toBeUndefined();
    expect(accessTokenFromFragment(`#access=${'x'.repeat(129)}`)).toBeUndefined();
  });
});
