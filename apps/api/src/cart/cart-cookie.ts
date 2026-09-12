import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

export const CART_COOKIE_NAME = 'pulse_field_cart';
export const CART_COOKIE_PATH = '/api/v1';
export const CART_INACTIVITY_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
export const CART_ABSOLUTE_TIMEOUT_MS = 90 * 24 * 60 * 60 * 1000;
const CART_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function createCartToken(): string {
  return randomBytes(32).toString('base64url');
}

export function digestCartToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function readCartToken(request: Request): string | undefined {
  const cookieHeader = request.header('cookie');
  if (!cookieHeader) return undefined;
  const matches = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${CART_COOKIE_NAME}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]?.slice(CART_COOKIE_NAME.length + 1);
  return value && CART_TOKEN_PATTERN.test(value) ? value : undefined;
}

export function setCartCookie(response: Response, token: string, secure: boolean): void {
  response.cookie(CART_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: CART_COOKIE_PATH,
    maxAge: CART_INACTIVITY_TIMEOUT_MS,
  });
}
