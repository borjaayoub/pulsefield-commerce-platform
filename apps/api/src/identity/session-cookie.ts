import type { CookieOptions, Request, Response } from 'express';
import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
} from './identity.constants';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function options(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: SESSION_COOKIE_PATH,
  };
}

export function readSessionCookie(request: Request): string | undefined {
  const cookieHeader = request.header('cookie');
  if (!cookieHeader) {
    return undefined;
  }

  const matches = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));

  if (matches.length !== 1) {
    return undefined;
  }

  const value = matches[0]?.slice(SESSION_COOKIE_NAME.length + 1);
  return value && SESSION_ID_PATTERN.test(value) ? value : undefined;
}

export function setSessionCookie(response: Response, sessionId: string, secure: boolean): void {
  response.cookie(SESSION_COOKIE_NAME, sessionId, {
    ...options(secure),
    maxAge: SESSION_ABSOLUTE_TIMEOUT_MS,
  });
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(SESSION_COOKIE_NAME, options(secure));
}
