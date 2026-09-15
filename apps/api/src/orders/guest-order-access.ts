import { createHash, createHmac, randomUUID } from 'node:crypto';

export const GUEST_ORDER_ACCESS_KEY = Symbol('GUEST_ORDER_ACCESS_KEY');
export const GUEST_ORDER_ACCESS_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

export function createGuestOrderAccessToken(
  orderId: string,
  keyBase64: string,
  id: string = randomUUID(),
): {
  id: string;
  token: string;
  tokenDigest: string;
} {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('Guest order access key must be 32 bytes.');
  const signature = createHmac('sha256', key)
    .update(`pulse-field:guest-order-access:v1:${id}:${orderId}`, 'utf8')
    .digest('base64url');
  const token = `${id}.${signature}`;
  return { id, token, tokenDigest: digestGuestOrderAccessToken(token) };
}

export function digestGuestOrderAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function readGuestOrderAccessToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith('Guest ')) return undefined;
  const token = authorization.slice(6);
  return TOKEN_PATTERN.test(token) ? token : undefined;
}
