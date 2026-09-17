import {
  allocateInventory,
  type AllocationLine,
  type AvailableInventory,
  type EligibleWarehouse,
} from './inventory-allocation';

const warehouses: EligibleWarehouse[] = [
  { warehouseId: 'us', priority: 1 },
  { warehouseId: 'eu', priority: 2 },
  { warehouseId: 'ma', priority: 3 },
];

function stock(entries: Array<[string, string, number]>): AvailableInventory[] {
  return entries.map(([warehouseId, variantId, available]) => ({
    warehouseId,
    variantId,
    available,
  }));
}

describe('distributed inventory allocation', () => {
  it('uses the preferred warehouse when it covers the complete order', () => {
    expect(
      allocateInventory(
        [
          { variantId: 'a', quantity: 2 },
          { variantId: 'b', quantity: 1 },
        ],
        warehouses,
        stock([
          ['us', 'a', 2],
          ['us', 'b', 1],
          ['eu', 'a', 10],
          ['eu', 'b', 10],
        ]),
      ),
    ).toEqual([
      { warehouseId: 'us', variantId: 'a', quantity: 2 },
      { warehouseId: 'us', variantId: 'b', quantity: 1 },
    ]);
  });

  it('prefers one fallback warehouse over a split involving the primary', () => {
    expect(
      allocateInventory(
        [{ variantId: 'a', quantity: 3 }],
        warehouses,
        stock([
          ['us', 'a', 2],
          ['eu', 'a', 3],
          ['ma', 'a', 8],
        ]),
      ),
    ).toEqual([{ warehouseId: 'eu', variantId: 'a', quantity: 3 }]);
  });

  it('splits the same variant only when no single warehouse covers it', () => {
    expect(
      allocateInventory(
        [{ variantId: 'a', quantity: 5 }],
        warehouses,
        stock([
          ['us', 'a', 3],
          ['eu', 'a', 2],
          ['ma', 'a', 4],
        ]),
      ),
    ).toEqual([
      { warehouseId: 'us', variantId: 'a', quantity: 3 },
      { warehouseId: 'eu', variantId: 'a', quantity: 2 },
    ]);
  });

  it('returns null rather than a partial allocation', () => {
    expect(
      allocateInventory(
        [
          { variantId: 'a', quantity: 2 },
          { variantId: 'b', quantity: 2 },
        ],
        warehouses,
        stock([
          ['us', 'a', 2],
          ['eu', 'b', 1],
        ]),
      ),
    ).toBeNull();
  });

  it('ignores stock from warehouses outside the eligible policy snapshot', () => {
    expect(
      allocateInventory(
        [{ variantId: 'a', quantity: 2 }],
        [{ warehouseId: 'us', priority: 1 }],
        stock([
          ['us', 'a', 1],
          ['inactive', 'a', 10],
        ]),
      ),
    ).toBeNull();
  });

  it('is deterministic across input ordering', () => {
    const lines: AllocationLine[] = [
      { variantId: 'b', quantity: 2 },
      { variantId: 'a', quantity: 3 },
    ];
    const availability = stock([
      ['ma', 'b', 2],
      ['eu', 'a', 2],
      ['us', 'b', 1],
      ['us', 'a', 1],
      ['eu', 'b', 1],
    ]);
    expect(
      allocateInventory(lines, [...warehouses].reverse(), [...availability].reverse()),
    ).toEqual(allocateInventory([...lines].reverse(), warehouses, availability));
  });

  it.each([
    [[{ variantId: 'a', quantity: 0 }], warehouses, [], /positive safe integer/u],
    [
      [
        { variantId: 'a', quantity: 1 },
        { variantId: 'a', quantity: 1 },
      ],
      warehouses,
      [],
      /Duplicate/u,
    ],
    [
      [{ variantId: 'a', quantity: 1 }],
      [
        { warehouseId: 'us', priority: 1 },
        { warehouseId: 'eu', priority: 1 },
      ],
      [],
      /Duplicate warehouse priority/u,
    ],
    [
      [{ variantId: 'a', quantity: 1 }],
      warehouses,
      stock([
        ['us', 'a', 1],
        ['us', 'a', 2],
      ]),
      /Duplicate availability/u,
    ],
  ] as Array<[AllocationLine[], EligibleWarehouse[], AvailableInventory[], RegExp]>)(
    'rejects an invalid allocation snapshot',
    (lines, eligible, availability, pattern) => {
      expect(() => allocateInventory(lines, eligible, availability)).toThrow(pattern);
    },
  );

  it('handles safe-integer availability without overflowing coverage totals', () => {
    expect(
      allocateInventory(
        [{ variantId: 'a', quantity: Number.MAX_SAFE_INTEGER }],
        warehouses,
        stock([
          ['us', 'a', Number.MAX_SAFE_INTEGER - 1],
          ['eu', 'a', Number.MAX_SAFE_INTEGER - 1],
        ]),
      ),
    ).toEqual([
      { warehouseId: 'us', variantId: 'a', quantity: Number.MAX_SAFE_INTEGER - 1 },
      { warehouseId: 'eu', variantId: 'a', quantity: 1 },
    ]);
  });

  it('exhaustively minimizes warehouse count and conserves requested quantities', () => {
    const lines = [
      { variantId: 'a', quantity: 2 },
      { variantId: 'b', quantity: 2 },
    ];
    for (let usA = 0; usA <= 2; usA += 1) {
      for (let usB = 0; usB <= 2; usB += 1) {
        for (let euA = 0; euA <= 2; euA += 1) {
          for (let euB = 0; euB <= 2; euB += 1) {
            for (let maA = 0; maA <= 2; maA += 1) {
              for (let maB = 0; maB <= 2; maB += 1) {
                const availability = stock([
                  ['us', 'a', usA],
                  ['us', 'b', usB],
                  ['eu', 'a', euA],
                  ['eu', 'b', euB],
                  ['ma', 'a', maA],
                  ['ma', 'b', maB],
                ]);
                const result = allocateInventory(lines, warehouses, availability);
                const coveringSizes = [1, 2, 3].filter((size) =>
                  warehouseSubsets(size).some((subset) =>
                    lines.every(
                      (line) =>
                        subset.reduce(
                          (sum, warehouseId) =>
                            sum +
                            (availability.find(
                              (row) =>
                                row.warehouseId === warehouseId && row.variantId === line.variantId,
                            )?.available ?? 0),
                          0,
                        ) >= line.quantity,
                    ),
                  ),
                );
                if (coveringSizes.length === 0) {
                  expect(result).toBeNull();
                  continue;
                }
                expect(result).not.toBeNull();
                expect(new Set(result!.map((item) => item.warehouseId)).size).toBe(
                  Math.min(...coveringSizes),
                );
                for (const line of lines) {
                  expect(
                    result!
                      .filter((item) => item.variantId === line.variantId)
                      .reduce((sum, item) => sum + item.quantity, 0),
                  ).toBe(line.quantity);
                }
              }
            }
          }
        }
      }
    }
  });
});

function warehouseSubsets(size: number): string[][] {
  if (size === 1) return [['us'], ['eu'], ['ma']];
  if (size === 2)
    return [
      ['us', 'eu'],
      ['us', 'ma'],
      ['eu', 'ma'],
    ];
  return [['us', 'eu', 'ma']];
}
