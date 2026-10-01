import { InventoryAdjustmentDto, InventoryTransferTransitionDto } from './inventory-operations.dto';
import { fingerprintIdempotentRequest } from '../idempotency/request-fingerprint';
import { InventoryOperationsService } from './inventory-operations.service';
import { RoleName } from '../generated/prisma/enums';

describe('inventory operation command fingerprints', () => {
  it('canonicalizes transformed DTO instances as plain command data', () => {
    const adjustment = Object.assign(new InventoryAdjustmentDto(), {
      onHandDelta: 2,
      damagedDelta: -1,
      reason: 'Cycle count',
    });
    expect(() =>
      fingerprintIdempotentRequest('inventory.adjustment', {
        balanceId: 'balance-1',
        onHandDelta: adjustment.onHandDelta,
        damagedDelta: adjustment.damagedDelta,
        reason: adjustment.reason,
        expectedVersion: 3,
      }),
    ).not.toThrow();
    const transition = Object.assign(new InventoryTransferTransitionDto(), {
      targetStatus: 'RECEIVED',
      reason: 'Receive transfer',
      lines: [{ variantId: 'variant-1', received: 2, damaged: 1, lost: 0 }],
    });
    expect(() =>
      fingerprintIdempotentRequest('inventory.transfer.transition', {
        transferId: 'transfer-1',
        targetStatus: transition.targetStatus,
        reason: transition.reason,
        lines: transition.lines.map((line) => ({ ...line })),
        expectedVersion: 1,
      }),
    ).not.toThrow();
  });
  it('passes plain fingerprints from real transformed DTOs through the command service', async () => {
    const begin = jest.fn().mockRejectedValue(new Error('stop after fingerprint'));
    const service = new InventoryOperationsService(
      {} as never,
      { begin } as never,
      {} as never,
      Buffer.alloc(32, 1).toString('base64'),
    );
    const dto = Object.assign(new InventoryAdjustmentDto(), {
      onHandDelta: 1,
      damagedDelta: 0,
      reason: 'Stock recount',
    });
    await expect(
      service.adjust(
        'balance-1',
        dto,
        1,
        { id: 'admin-1', roles: [RoleName.ADMINISTRATOR] },
        'inventory-key-1',
        'request-1',
      ),
    ).rejects.toThrow('stop after fingerprint');
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          balanceId: 'balance-1',
          onHandDelta: 1,
          damagedDelta: 0,
          expectedVersion: 1,
          reason: 'Stock recount',
        },
      }),
      expect.anything(),
    );
  });
  it('rejects a missing idempotency key before opening a transaction', async () => {
    const begin = jest.fn();
    const service = new InventoryOperationsService(
      {} as never,
      { begin } as never,
      {} as never,
      Buffer.alloc(32, 1).toString('base64'),
    );
    const dto = Object.assign(new InventoryAdjustmentDto(), {
      onHandDelta: 1,
      damagedDelta: 0,
      reason: 'Stock recount',
    });
    await expect(
      service.adjust(
        'balance-1',
        dto,
        1,
        { id: 'admin-1', roles: [RoleName.ADMINISTRATOR] },
        undefined,
        'request-1',
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_OPERATION_INVALID' });
    expect(begin).not.toHaveBeenCalled();
  });
});
