import { randomBytes } from 'node:crypto';

export const DEFAULT_API_ORIGIN = 'http://localhost:4000';

export function createCspNonce(): string {
  return randomBytes(16).toString('base64');
}

export function safeApiOrigin(value: string | undefined): string {
  if (!value) return DEFAULT_API_ORIGIN;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return DEFAULT_API_ORIGIN;
    return parsed.origin;
  } catch {
    return DEFAULT_API_ORIGIN;
  }
}

export function buildContentSecurityPolicy(
  nonce: string,
  isDevelopment: boolean,
  configuredApiOrigin?: string,
): string {
  const apiOrigin = safeApiOrigin(configuredApiOrigin ?? process.env.NEXT_PUBLIC_API_ORIGIN);
  const realtimeOrigin = apiOrigin.replace(/^http:/u, 'ws:').replace(/^https:/u, 'wss:');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' https://js.stripe.com https://*.js.stripe.com${isDevelopment ? " 'unsafe-eval'" : ''}`,
    `connect-src 'self' ${apiOrigin} ${realtimeOrigin} https://api.stripe.com`,
    'frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com',
    "form-action 'self'",
  ].join('; ');
}
