import type { Request, Response } from 'express';
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_COOKIE_NAME } from './identity.constants';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-cookie';

describe('session cookie boundary', () => {
  const sessionId = Buffer.alloc(32, 7).toString('base64url');

  function requestWithCookie(cookie?: string): Request {
    return { header: jest.fn(() => cookie) } as unknown as Request;
  }

  it('reads exactly one well-formed opaque session identifier', () => {
    expect(
      readSessionCookie(requestWithCookie(`theme=dark; ${SESSION_COOKIE_NAME}=${sessionId}`)),
    ).toBe(sessionId);
    expect(
      readSessionCookie(
        requestWithCookie(
          `${SESSION_COOKIE_NAME}=${sessionId}; ${SESSION_COOKIE_NAME}=${sessionId}`,
        ),
      ),
    ).toBeUndefined();
    expect(
      readSessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=not-valid`)),
    ).toBeUndefined();
  });

  it('sets the local cookie with HttpOnly, SameSite, path, and absolute lifetime', () => {
    const cookie = jest.fn();
    setSessionCookie({ cookie } as unknown as Response, sessionId, false);

    expect(cookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/api/v1',
      maxAge: SESSION_ABSOLUTE_TIMEOUT_MS,
    });
  });

  it('uses the same security scope when clearing the cookie', () => {
    const clearCookie = jest.fn();
    clearSessionCookie({ clearCookie } as unknown as Response, true);

    expect(clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/api/v1',
    });
  });
});
