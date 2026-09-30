import { FulfillmentGroupStatus } from '../generated/prisma/enums';

export const FULFILLMENT_PROGRESS = [
  'PREPARING',
  'PARTIALLY_SHIPPED',
  'SHIPPED',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
] as const;

export type FulfillmentProgress = (typeof FULFILLMENT_PROGRESS)[number];

/**
 * A read-model projection of independent group state. It deliberately does not
 * mutate, or replace, the payment/order lifecycle state held by Order.status.
 */
export function fulfillmentProgress(
  statuses: readonly FulfillmentGroupStatus[],
): FulfillmentProgress {
  if (!statuses.length) return 'PREPARING';
  if (statuses.every((status) => status === FulfillmentGroupStatus.DELIVERED)) return 'DELIVERED';
  if (statuses.some((status) => status === FulfillmentGroupStatus.DELIVERED))
    return 'PARTIALLY_DELIVERED';

  const shippedOrDelivered = (status: FulfillmentGroupStatus) =>
    status === FulfillmentGroupStatus.SHIPPED || status === FulfillmentGroupStatus.DELIVERED;
  if (statuses.every(shippedOrDelivered)) return 'SHIPPED';
  if (statuses.some(shippedOrDelivered)) return 'PARTIALLY_SHIPPED';
  return 'PREPARING';
}
