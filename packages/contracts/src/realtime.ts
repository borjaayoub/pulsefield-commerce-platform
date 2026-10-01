export const REALTIME_PROTOCOL_VERSION = 1 as const;

export const REALTIME_TOPICS = [
  'catalog',
  'fulfillment',
  'inventory',
  'transfers',
  'low-stock',
  'inventory-reconciliation',
] as const;

export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

export interface RealtimeInvalidationEnvelope {
  version: 1;
  streamId: string;
  sequence: number;
  topics: RealtimeTopic[];
}

export interface RealtimeResyncEnvelope {
  version: 1;
}

export function isRealtimeTopic(value: unknown): value is RealtimeTopic {
  return typeof value === 'string' && (REALTIME_TOPICS as readonly string[]).includes(value);
}

export function isRealtimeInvalidationEnvelope(
  value: unknown,
): value is RealtimeInvalidationEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    input.version === REALTIME_PROTOCOL_VERSION &&
    typeof input.streamId === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(input.streamId) &&
    Number.isSafeInteger(input.sequence) &&
    Number(input.sequence) > 0 &&
    Array.isArray(input.topics) &&
    input.topics.length > 0 &&
    input.topics.length <= REALTIME_TOPICS.length &&
    new Set(input.topics).size === input.topics.length &&
    input.topics.every(isRealtimeTopic)
  );
}
