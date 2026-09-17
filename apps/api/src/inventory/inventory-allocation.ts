export interface AllocationLine {
  variantId: string;
  quantity: number;
}

export interface EligibleWarehouse {
  warehouseId: string;
  priority: number;
}

export interface AvailableInventory {
  warehouseId: string;
  variantId: string;
  available: number;
}

export interface InventoryAllocation {
  warehouseId: string;
  variantId: string;
  quantity: number;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function combinations<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];

  function visit(start: number, selected: T[]): void {
    if (selected.length === size) {
      result.push([...selected]);
      return;
    }
    for (let index = start; index <= values.length - (size - selected.length); index += 1) {
      selected.push(values[index]!);
      visit(index + 1, selected);
      selected.pop();
    }
  }

  visit(0, []);
  return result;
}

/**
 * Selects the smallest eligible warehouse set that covers every line, then
 * allocates within that set in configured priority order. The function is pure;
 * callers remain responsible for locking and re-reading authoritative balances.
 */
export function allocateInventory(
  requestedLines: readonly AllocationLine[],
  eligibleWarehouses: readonly EligibleWarehouse[],
  availableInventory: readonly AvailableInventory[],
): InventoryAllocation[] | null {
  if (requestedLines.length === 0) throw new Error('At least one allocation line is required.');
  if (eligibleWarehouses.length === 0) return null;

  const lines = [...requestedLines].sort((left, right) =>
    left.variantId.localeCompare(right.variantId),
  );
  const lineIds = new Set<string>();
  for (const line of lines) {
    if (!line.variantId) throw new Error('Allocation variant IDs must be non-empty.');
    positiveInteger(line.quantity, `Quantity for variant ${line.variantId}`);
    if (lineIds.has(line.variantId))
      throw new Error(`Duplicate allocation line: ${line.variantId}.`);
    lineIds.add(line.variantId);
  }

  const warehouses = [...eligibleWarehouses].sort(
    (left, right) =>
      left.priority - right.priority || left.warehouseId.localeCompare(right.warehouseId),
  );
  const warehouseIds = new Set<string>();
  const priorities = new Set<number>();
  for (const warehouse of warehouses) {
    if (!warehouse.warehouseId) throw new Error('Eligible warehouse IDs must be non-empty.');
    positiveInteger(warehouse.priority, `Priority for warehouse ${warehouse.warehouseId}`);
    if (warehouseIds.has(warehouse.warehouseId)) {
      throw new Error(`Duplicate eligible warehouse: ${warehouse.warehouseId}.`);
    }
    if (priorities.has(warehouse.priority)) {
      throw new Error(`Duplicate warehouse priority: ${warehouse.priority}.`);
    }
    warehouseIds.add(warehouse.warehouseId);
    priorities.add(warehouse.priority);
  }

  const availability = new Map<string, number>();
  for (const balance of availableInventory) {
    if (!balance.warehouseId || !balance.variantId) {
      throw new Error('Availability warehouse and variant IDs must be non-empty.');
    }
    nonNegativeInteger(
      balance.available,
      `Availability for ${balance.warehouseId}/${balance.variantId}`,
    );
    const key = `${balance.warehouseId}:${balance.variantId}`;
    if (availability.has(key)) throw new Error(`Duplicate availability row: ${key}.`);
    availability.set(key, balance.available);
  }

  let selected: EligibleWarehouse[] | null = null;
  for (let size = 1; size <= warehouses.length && !selected; size += 1) {
    selected =
      combinations(warehouses, size).find((candidate) =>
        lines.every(
          (line) =>
            candidate.reduce((total, warehouse) => {
              const available = availability.get(`${warehouse.warehouseId}:${line.variantId}`) ?? 0;
              return total >= line.quantity - available ? line.quantity : total + available;
            }, 0) >= line.quantity,
        ),
      ) ?? null;
  }
  if (!selected) return null;

  const allocations: InventoryAllocation[] = [];
  for (const line of lines) {
    let remaining = line.quantity;
    for (const warehouse of selected) {
      const available = availability.get(`${warehouse.warehouseId}:${line.variantId}`) ?? 0;
      const quantity = Math.min(remaining, available);
      if (quantity > 0) {
        allocations.push({
          warehouseId: warehouse.warehouseId,
          variantId: line.variantId,
          quantity,
        });
        remaining -= quantity;
      }
      if (remaining === 0) break;
    }
    if (remaining !== 0) throw new Error('Selected allocation set no longer covers every line.');
  }
  return allocations;
}
