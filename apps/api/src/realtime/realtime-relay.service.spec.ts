import {
  FULFILLMENT_INVALIDATED_EVENT,
  INVENTORY_INVALIDATED_EVENT,
  TRANSFER_INVALIDATED_EVENT,
} from './realtime.events';
import { topicsFor } from './realtime-relay.service';

describe('realtime invalidation topic mapping', () => {
  it('does not turn threshold-only inventory work into a public catalog hint', () => {
    expect(topicsFor(INVENTORY_INVALIDATED_EVENT, 'inventory-threshold')).toEqual([
      'inventory',
      'low-stock',
      'inventory-reconciliation',
    ]);
  });

  it('keeps transfer intent private while retaining stock projection invalidation', () => {
    expect(topicsFor(TRANSFER_INVALIDATED_EVENT, 'inventory-transfer')).toEqual(['transfers']);
    expect(topicsFor(TRANSFER_INVALIDATED_EVENT, 'inventory-balance')).toEqual([
      'transfers',
      'inventory',
      'low-stock',
      'inventory-reconciliation',
    ]);
  });

  it('maps fulfillment changes only to the fulfillment projection', () => {
    expect(topicsFor(FULFILLMENT_INVALIDATED_EVENT, 'fulfillment-group')).toEqual([
      'fulfillment',
    ]);
  });
});
