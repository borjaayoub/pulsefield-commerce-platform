import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  FulfillmentRegion,
  InventoryAllocationPolicyLifecycle,
  WarehouseStatus,
} from '../generated/prisma/enums';
import {
  allocateInventory,
  type AllocationLine,
  type InventoryAllocation,
} from './inventory-allocation';

const US_ALLOCATION_POLICY_CODE = 'US-FULFILLMENT';

export class InventoryAllocationPolicyUnavailableError extends Error {
  constructor() {
    super('An active inventory allocation policy is unavailable.');
  }
}

type InventoryClient = PrismaService | Prisma.TransactionClient;

export interface AllocationBalance {
  id: string;
  warehouseId: string;
  variantId: string;
  onHand: number;
  reserved: number;
  allocated: number;
  damaged: number;
}

export interface PersistedInventoryAllocation {
  policyVersionId: string;
  allocations: InventoryAllocation[];
  balancesByKey: Map<string, AllocationBalance>;
}

function balanceKey(warehouseId: string, variantId: string): string {
  return `${warehouseId}:${variantId}`;
}

async function decideInventoryAllocation(
  client: InventoryClient,
  lines: readonly AllocationLine[],
  lockBalances: boolean,
  policyVersionId?: string,
  allowRetired = false,
): Promise<PersistedInventoryAllocation | null> {
  const policyVersion = await client.inventoryAllocationPolicyVersion.findFirst({
    where: {
      ...(policyVersionId
        ? {
            id: policyVersionId,
            lifecycle: { in: allowRetired ? ['ACTIVE', 'RETIRED'] : ['ACTIVE'] },
          }
        : {
            lifecycle: InventoryAllocationPolicyLifecycle.ACTIVE,
            policy: { code: US_ALLOCATION_POLICY_CODE, destinationRegion: FulfillmentRegion.US },
          }),
    },
    select: {
      id: true,
      warehouses: {
        where: { warehouse: { status: WarehouseStatus.ACTIVE } },
        orderBy: { priority: 'asc' },
        select: { warehouseId: true, priority: true },
      },
    },
  });
  if (policyVersion && allowRetired && policyVersion.warehouses.length === 0) return null;
  if (!policyVersion || policyVersion.warehouses.length === 0) {
    throw new InventoryAllocationPolicyUnavailableError();
  }

  const variantIds = [...new Set(lines.map((line) => line.variantId))].sort();
  const warehouseIds = policyVersion.warehouses.map(({ warehouseId }) => warehouseId).sort();
  if (variantIds.length === 0) return null;

  if (lockBalances) {
    await client.$queryRaw`
      SELECT "id"
      FROM "InventoryBalance"
      WHERE "warehouseId" IN (${Prisma.join(warehouseIds)})
        AND "variantId" IN (${Prisma.join(variantIds)})
      ORDER BY "variantId" ASC, "warehouseId" ASC, "id" ASC
      FOR UPDATE
    `;
  }

  const balances = await client.inventoryBalance.findMany({
    where: { warehouseId: { in: warehouseIds }, variantId: { in: variantIds } },
    orderBy: [{ variantId: 'asc' }, { warehouseId: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      warehouseId: true,
      variantId: true,
      onHand: true,
      reserved: true,
      allocated: true,
      damaged: true,
    },
  });
  const balancesByKey = new Map(
    balances.map((balance) => [balanceKey(balance.warehouseId, balance.variantId), balance]),
  );
  const allocations = allocateInventory(
    lines,
    policyVersion.warehouses,
    balances.map((balance) => ({
      warehouseId: balance.warehouseId,
      variantId: balance.variantId,
      available: balance.onHand - balance.reserved - balance.allocated - balance.damaged,
    })),
  );
  if (!allocations) return null;
  return { policyVersionId: policyVersion.id, allocations, balancesByKey };
}

export function readInventoryAllocation(
  client: InventoryClient,
  lines: readonly AllocationLine[],
  policyVersionId?: string,
): Promise<PersistedInventoryAllocation | null> {
  return decideInventoryAllocation(client, lines, false, policyVersionId);
}

export function lockInventoryAllocation(
  transaction: Prisma.TransactionClient,
  lines: readonly AllocationLine[],
  policyVersionId?: string,
  allowRetired = false,
): Promise<PersistedInventoryAllocation | null> {
  return decideInventoryAllocation(transaction, lines, true, policyVersionId, allowRetired);
}

export function inventoryBalanceKey(warehouseId: string, variantId: string): string {
  return balanceKey(warehouseId, variantId);
}
