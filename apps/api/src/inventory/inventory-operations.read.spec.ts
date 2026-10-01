import { BadRequestException } from '@nestjs/common';
import { decodeInventoryCursor, encodeInventoryCursor } from './inventory-operations.read-support';
import { InventoryOperationsService } from './inventory-operations.service';

describe('inventory read cursors', () => {
  it('rejects malformed and wrong-resource cursors before reads', () => {
    expect(() => decodeInventoryCursor('a'.repeat(32), 'bad', 'inventory-low-stock')).toThrow(
      BadRequestException,
    );
  });
  it('round-trips signed v4 cursors and rejects tampering, wrong resources, and extra parts', () => {
    const key = Buffer.alloc(32, 4).toString('base64');
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const cursor = encodeInventoryCursor(
      key,
      'inventory-low-stock',
      new Date('2026-01-01T00:00:00.000Z'),
      id,
    );
    expect(decodeInventoryCursor(key, cursor, 'inventory-low-stock')).toMatchObject({
      id,
      resource: 'inventory-low-stock',
    });
    expect(() => decodeInventoryCursor(key, `${cursor}x`, 'inventory-low-stock')).toThrow(
      BadRequestException,
    );
    expect(() => decodeInventoryCursor(key, cursor, 'inventory-transfers')).toThrow(
      BadRequestException,
    );
    expect(() => decodeInventoryCursor(key, `${cursor}.extra`, 'inventory-low-stock')).toThrow(
      BadRequestException,
    );
  });
  it('invokes the low-stock projection with a bounded page', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id,
            warehouseId: id,
            variantId: id,
            onHand: 0,
            reserved: 0,
            allocated: 0,
            damaged: 0,
            lowStockThreshold: 0,
            version: 1,
            createdAt: new Date('2026-01-01'),
            warehouseCode: 'CASA',
            sku: 'SKU-1',
          },
        ]),
      user: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          verifiedAt: new Date(),
          userRoles: [{ role: 'ADMINISTRATOR' }],
        }),
      },
    };
    const service = new InventoryOperationsService(
      prisma as never,
      {} as never,
      {} as never,
      Buffer.alloc(32, 4).toString('base64'),
    );
    const result = await service.lowStock(
      { id, roles: ['ADMINISTRATOR'] as never },
      { pageSize: 1 },
    );
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});
