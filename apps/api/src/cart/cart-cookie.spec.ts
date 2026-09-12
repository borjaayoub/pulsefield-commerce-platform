import type { Request, Response } from 'express';
import {
  CART_COOKIE_NAME,
  CART_COOKIE_PATH,
  CART_INACTIVITY_TIMEOUT_MS,
  createCartToken,
  digestCartToken,
  readCartToken,
  setCartCookie,
} from './cart-cookie';

describe('anonymous cart cookie boundary', () => {
  it('creates a 256-bit base64url token and stores only its digest', () => {
    const token = createCartToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(digestCartToken(token)).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestCartToken(token)).not.toContain(token);
  });

  it('rejects malformed and duplicate cookies', () => {
    const request = {
      header: jest.fn().mockReturnValue(`${CART_COOKIE_NAME}=bad`),
    } as unknown as Request;
    expect(readCartToken(request)).toBeUndefined();
    request.header = jest
      .fn()
      .mockReturnValue(`${CART_COOKIE_NAME}=valid; ${CART_COOKIE_NAME}=valid`);
    expect(readCartToken(request)).toBeUndefined();
  });

  it('sets the scoped secure cookie without a domain', () => {
    const cookie = jest.fn();
    setCartCookie({ cookie } as unknown as Response, createCartToken(), false);
    expect(cookie).toHaveBeenCalledWith(
      CART_COOKIE_NAME,
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: CART_COOKIE_PATH,
        maxAge: CART_INACTIVITY_TIMEOUT_MS,
      },
    );
    expect(cookie.mock.calls[0]?.[2]).not.toHaveProperty('domain');
  });
});
