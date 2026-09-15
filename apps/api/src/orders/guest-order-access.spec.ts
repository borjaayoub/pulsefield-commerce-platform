import {
  createGuestOrderAccessToken,
  digestGuestOrderAccessToken,
  readGuestOrderAccessToken,
} from './guest-order-access';

describe('guest order access credential', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const orderId = '90000000-0000-4000-8000-000000000001';
  const grantId = '80000000-0000-4000-8000-000000000001';

  it('reproduces an order-bound token while exposing only a digest for storage', () => {
    const first = createGuestOrderAccessToken(orderId, key, grantId);
    const replay = createGuestOrderAccessToken(orderId, key, grantId);
    expect(first).toEqual(replay);
    expect(first.tokenDigest).toBe(digestGuestOrderAccessToken(first.token));
    expect(first.tokenDigest).not.toContain(first.token);
    expect(
      createGuestOrderAccessToken('90000000-0000-4000-8000-000000000002', key, grantId).token,
    ).not.toBe(first.token);
  });

  it('accepts only the bounded Guest authorization form', () => {
    const { token } = createGuestOrderAccessToken(orderId, key, grantId);
    expect(readGuestOrderAccessToken(`Guest ${token}`)).toBe(token);
    expect(readGuestOrderAccessToken(`Bearer ${token}`)).toBeUndefined();
    expect(readGuestOrderAccessToken('Guest malformed')).toBeUndefined();
  });
});
