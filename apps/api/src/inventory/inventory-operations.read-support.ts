import { BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

type InventoryCursor = { resource: string; createdAt: string; id: string };
export function encodeInventoryCursor(
  key: string,
  resource: string,
  createdAt: Date,
  id: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, resource, createdAt: createdAt.toISOString(), id }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`inventory-operations:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}
export function decodeInventoryCursor(
  key: string,
  value: string | undefined,
  resource: string,
): InventoryCursor | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 512) throw new Error('length');
    const parts = value.split('.');
    if (parts.length !== 2) throw new Error('parts');
    const [payload, signature] = parts;
    if (!payload || !signature) throw new Error('parts');
    const expected = createHmac('sha256', Buffer.from(key, 'base64'))
      .update(`inventory-operations:${payload}`)
      .digest('base64url');
    const actual = Buffer.from(signature, 'base64url');
    const wanted = Buffer.from(expected, 'base64url');
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
      throw new Error('signature');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const date = typeof parsed.createdAt === 'string' ? new Date(parsed.createdAt) : undefined;
    if (
      parsed.v !== 1 ||
      parsed.resource !== resource ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed.id) ||
      !date ||
      !Number.isFinite(date.getTime())
    )
      throw new Error('values');
    return { resource, createdAt: date.toISOString(), id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid inventory operations cursor.');
  }
}
