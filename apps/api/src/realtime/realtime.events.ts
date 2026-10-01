import type { Prisma } from '../generated/prisma/client';
import { randomUUID } from 'node:crypto';

export const INVENTORY_INVALIDATED_EVENT = 'commerce.inventory.invalidated';
export const TRANSFER_INVALIDATED_EVENT = 'commerce.inventory-transfer.invalidated';
export const FULFILLMENT_INVALIDATED_EVENT = 'commerce.fulfillment.invalidated';
export const REALTIME_EVENT_VERSION = 1;

type Writer = Prisma.TransactionClient;

function validId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export async function appendRealtimeInvalidation(
  tx: Writer,
  input: {
    type:
      | typeof INVENTORY_INVALIDATED_EVENT
      | typeof TRANSFER_INVALIDATED_EVENT
      | typeof FULFILLMENT_INVALIDATED_EVENT;
    aggregateType: string;
    resourceId: string;
    resourceVersion: number;
    correlationId: string;
    causationId?: string;
  },
): Promise<void> {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/u.test(input.aggregateType) ||
    !validId(input.resourceId) ||
    !Number.isSafeInteger(input.resourceVersion) ||
    input.resourceVersion < 1
  ) {
    throw new Error('Invalid realtime outbox resource.');
  }
  await tx.outboxMessage.create({
    data: {
      id: randomUUID(),
      eventType: input.type,
      eventVersion: REALTIME_EVENT_VERSION,
      aggregateType: input.aggregateType,
      aggregateId: input.resourceId,
      payload: {
        version: REALTIME_EVENT_VERSION,
        resourceId: input.resourceId,
        resourceVersion: input.resourceVersion,
      },
      correlationId: input.correlationId,
      causationId: input.causationId,
    },
  });
}
