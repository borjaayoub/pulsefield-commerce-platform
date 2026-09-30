import { FulfillmentGroupStatus } from '../generated/prisma/enums';
import { fulfillmentProgress } from './fulfillment-progress';

describe('fulfillment progress projection', () => {
  it.each([
    [[], 'PREPARING'],
    [[FulfillmentGroupStatus.ALLOCATED], 'PREPARING'],
    [[FulfillmentGroupStatus.PICKING, FulfillmentGroupStatus.PACKED], 'PREPARING'],
    [[FulfillmentGroupStatus.SHIPPED, FulfillmentGroupStatus.PACKED], 'PARTIALLY_SHIPPED'],
    [[FulfillmentGroupStatus.SHIPPED, FulfillmentGroupStatus.SHIPPED], 'SHIPPED'],
    [[FulfillmentGroupStatus.SHIPPED, FulfillmentGroupStatus.DELIVERED], 'PARTIALLY_DELIVERED'],
    [[FulfillmentGroupStatus.DELIVERED, FulfillmentGroupStatus.PACKED], 'PARTIALLY_DELIVERED'],
    [[FulfillmentGroupStatus.DELIVERED, FulfillmentGroupStatus.DELIVERED], 'DELIVERED'],
  ] as const)('derives %s as %s', (statuses, expected) => {
    expect(fulfillmentProgress(statuses)).toBe(expected);
  });
});
