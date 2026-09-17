import { randomUUID } from 'node:crypto';
import { PHASE_3_SEED_COUNTS, seedPhase3Commerce } from '../../prisma/seed-commerce';
import { PrismaService } from '../database/prisma.service';
import {
  AuditActorType,
  CatalogLifecycle,
  FulfillmentRegion,
  InventoryAllocationPolicyLifecycle,
  InventoryMovementType,
  PriceBookVersionLifecycle,
} from '../generated/prisma/enums';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('catalog and inventory foundation database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);

  async function clearCommerceData(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "InventoryMovement",
        "InventoryBalance",
        "InventoryAllocationPolicyWarehouse",
        "InventoryAllocationPolicyVersion",
        "InventoryAllocationPolicy",
        "Warehouse",
        "VariantPrice",
        "PriceBookVersion",
        "PriceBook",
        "ProductMedia",
        "ProductCategory",
        "Category",
        "ProductVariant",
        "ProductSlug",
        "Product"
      CASCADE
    `);
  }

  beforeEach(clearCommerceData);

  afterAll(async () => {
    await clearCommerceData();
    await prisma.$disconnect();
  });

  it('repeats the deterministic regional inventory seed without duplicating commerce records', async () => {
    await seedPhase3Commerce(prisma);
    await seedPhase3Commerce(prisma);

    await expect(prisma.product.count()).resolves.toBe(PHASE_3_SEED_COUNTS.products);
    await expect(prisma.productVariant.count()).resolves.toBe(PHASE_3_SEED_COUNTS.variants);
    await expect(prisma.category.count()).resolves.toBe(PHASE_3_SEED_COUNTS.categories);
    await expect(prisma.productMedia.count()).resolves.toBe(PHASE_3_SEED_COUNTS.media);
    await expect(prisma.priceBook.count()).resolves.toBe(PHASE_3_SEED_COUNTS.priceBooks);
    await expect(prisma.warehouse.count()).resolves.toBe(PHASE_3_SEED_COUNTS.warehouses);
    await expect(prisma.variantPrice.count()).resolves.toBe(PHASE_3_SEED_COUNTS.variants);
    await expect(prisma.inventoryBalance.count()).resolves.toBe(
      PHASE_3_SEED_COUNTS.inventoryBalances,
    );
    await expect(prisma.inventoryMovement.count()).resolves.toBe(
      PHASE_3_SEED_COUNTS.inventoryMovements,
    );
    await expect(prisma.inventoryAllocationPolicy.count()).resolves.toBe(
      PHASE_3_SEED_COUNTS.allocationPolicies,
    );
    await expect(prisma.inventoryAllocationPolicyVersion.count()).resolves.toBe(
      PHASE_3_SEED_COUNTS.allocationPolicyVersions,
    );
    await expect(prisma.inventoryAllocationPolicyWarehouse.count()).resolves.toBe(
      PHASE_3_SEED_COUNTS.allocationPolicyWarehouses,
    );

    const media = await prisma.productMedia.findMany({ orderBy: { storageKey: 'asc' } });
    expect(
      media.every(
        ({ status, storageKey }) =>
          status === CatalogLifecycle.ACTIVE && storageKey.endsWith('.svg'),
      ),
    ).toBe(true);

    await expect(
      prisma.priceBook.findUniqueOrThrow({
        where: { code: 'US-RETAIL' },
        include: { versions: { include: { prices: true } } },
      }),
    ).resolves.toMatchObject({
      marketCode: 'US',
      currencyCode: 'USD',
      versions: [
        {
          version: 1,
          lifecycle: PriceBookVersionLifecycle.ACTIVE,
        },
      ],
    });

    const balances = await prisma.inventoryBalance.findMany();
    expect(
      balances.every(
        ({ onHand, reserved, allocated, damaged }) => onHand >= reserved + allocated + damaged,
      ),
    ).toBe(true);
    await expect(
      prisma.inventoryMovement.count({ where: { type: InventoryMovementType.INITIAL_STOCK } }),
    ).resolves.toBe(PHASE_3_SEED_COUNTS.inventoryMovements);

    await expect(
      prisma.inventoryAllocationPolicy.findUniqueOrThrow({
        where: { code: 'US-FULFILLMENT' },
        include: {
          versions: {
            include: {
              warehouses: {
                orderBy: { priority: 'asc' },
                include: { warehouse: true },
              },
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      destinationRegion: FulfillmentRegion.US,
      versions: [
        {
          version: 1,
          lifecycle: InventoryAllocationPolicyLifecycle.ACTIVE,
          warehouses: [
            { priority: 1, warehouse: { code: 'US-EAST-01', fulfillmentRegion: 'US' } },
            { priority: 2, warehouse: { code: 'EU-CENTRAL-01', fulfillmentRegion: 'EU' } },
            { priority: 3, warehouse: { code: 'MA-CASA-01', fulfillmentRegion: 'MOROCCO' } },
          ],
        },
      ],
    });
  });

  it('keeps activated allocation policy and warehouse-region history immutable', async () => {
    await seedPhase3Commerce(prisma);
    const policy = await prisma.inventoryAllocationPolicy.findUniqueOrThrow({
      where: { code: 'US-FULFILLMENT' },
      include: { versions: { include: { warehouses: true } } },
    });
    const version = policy.versions[0]!;
    const assignment = version.warehouses[0]!;
    const warehouse = await prisma.warehouse.findUniqueOrThrow({
      where: { id: assignment.warehouseId },
    });

    await expect(
      prisma.warehouse.update({
        where: { id: warehouse.id },
        data: { fulfillmentRegion: FulfillmentRegion.EU },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryAllocationPolicyWarehouse.update({
        where: {
          policyVersionId_warehouseId: {
            policyVersionId: version.id,
            warehouseId: assignment.warehouseId,
          },
        },
        data: { priority: 10 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryAllocationPolicy.delete({ where: { id: policy.id } }),
    ).rejects.toThrow();
  });

  it('activates only complete region-matched policy drafts and keeps one active version', async () => {
    await seedPhase3Commerce(prisma);
    const policy = await prisma.inventoryAllocationPolicy.findUniqueOrThrow({
      where: { code: 'US-FULFILLMENT' },
    });
    const warehouses = await prisma.warehouse.findMany({ orderBy: { code: 'asc' } });
    const usWarehouse = warehouses.find(
      ({ fulfillmentRegion }) => fulfillmentRegion === FulfillmentRegion.US,
    )!;
    const euWarehouse = warehouses.find(
      ({ fulfillmentRegion }) => fulfillmentRegion === FulfillmentRegion.EU,
    )!;

    await expect(
      prisma.inventoryAllocationPolicyVersion.create({
        data: {
          policyId: policy.id,
          version: 99,
          lifecycle: InventoryAllocationPolicyLifecycle.ACTIVE,
          activatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    const secondVersion = await prisma.inventoryAllocationPolicyVersion.create({
      data: { policyId: policy.id, version: 2 },
    });
    await prisma.inventoryAllocationPolicyWarehouse.create({
      data: { policyVersionId: secondVersion.id, warehouseId: usWarehouse.id, priority: 1 },
    });
    await expect(
      prisma.inventoryAllocationPolicyVersion.update({
        where: { id: secondVersion.id },
        data: {
          lifecycle: InventoryAllocationPolicyLifecycle.ACTIVE,
          activatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    const gappedPolicy = await prisma.inventoryAllocationPolicy.create({
      data: { code: 'US-GAPPED', destinationRegion: FulfillmentRegion.US },
    });
    const gappedVersion = await prisma.inventoryAllocationPolicyVersion.create({
      data: { policyId: gappedPolicy.id, version: 1 },
    });
    await prisma.inventoryAllocationPolicyWarehouse.createMany({
      data: [
        { policyVersionId: gappedVersion.id, warehouseId: usWarehouse.id, priority: 1 },
        { policyVersionId: gappedVersion.id, warehouseId: euWarehouse.id, priority: 3 },
      ],
    });
    await expect(
      prisma.inventoryAllocationPolicyVersion.update({
        where: { id: gappedVersion.id },
        data: {
          lifecycle: InventoryAllocationPolicyLifecycle.ACTIVE,
          activatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    const mismatchedPolicy = await prisma.inventoryAllocationPolicy.create({
      data: { code: 'MA-MISMATCHED', destinationRegion: FulfillmentRegion.MOROCCO },
    });
    const mismatchedVersion = await prisma.inventoryAllocationPolicyVersion.create({
      data: { policyId: mismatchedPolicy.id, version: 1 },
    });
    await prisma.inventoryAllocationPolicyWarehouse.create({
      data: {
        policyVersionId: mismatchedVersion.id,
        warehouseId: usWarehouse.id,
        priority: 1,
      },
    });
    await expect(
      prisma.inventoryAllocationPolicyVersion.update({
        where: { id: mismatchedVersion.id },
        data: {
          lifecycle: InventoryAllocationPolicyLifecycle.ACTIVE,
          activatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('allows one reservation variant to be allocated across warehouses', async () => {
    await seedPhase3Commerce(prisma);
    const variant = await prisma.productVariant.findFirstOrThrow();
    const warehouses = await prisma.warehouse.findMany({ orderBy: { code: 'asc' }, take: 2 });
    const reservation = await prisma.inventoryReservation.create({
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });

    await prisma.inventoryReservationItem.createMany({
      data: warehouses.map((warehouse) => ({
        reservationId: reservation.id,
        warehouseId: warehouse.id,
        variantId: variant.id,
        quantity: 1,
      })),
    });
    await expect(
      prisma.inventoryReservationItem.count({ where: { reservationId: reservation.id } }),
    ).resolves.toBe(2);
    await expect(
      prisma.inventoryReservationItem.create({
        data: {
          reservationId: reservation.id,
          warehouseId: warehouses[0]!.id,
          variantId: variant.id,
          quantity: 1,
        },
      }),
    ).rejects.toThrow();
  });

  it('installs trigram indexes for the case-insensitive search columns', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('Product_name_trgm_idx', 'Product_description_trgm_idx')
      ORDER BY indexname
    `;

    expect(indexes).toHaveLength(2);
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      'Product_description_trgm_idx',
      'Product_name_trgm_idx',
    ]);
    expect(indexes.every(({ indexdef }) => indexdef.includes('gin_trgm_ops'))).toBe(true);
  });

  it('requires exactly one canonical slug for an active product', async () => {
    await expect(
      prisma.product.create({
        data: {
          id: randomUUID(),
          name: 'Missing canonical slug',
          description: 'An invalid active product used to prove the deferred database constraint.',
          status: CatalogLifecycle.ACTIVE,
          specificationSchemaVersion: 1,
          specifications: {},
        },
      }),
    ).rejects.toThrow();

    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        name: 'Draft product',
        description: 'A draft may exist before its canonical slug is assigned.',
        status: CatalogLifecycle.DRAFT,
        specificationSchemaVersion: 1,
        specifications: {},
      },
    });
    await prisma.productSlug.create({
      data: { productId, slug: `draft-${productId}`, isCanonical: true },
    });
    await expect(
      prisma.productSlug.create({
        data: { productId, slug: `duplicate-${productId}`, isCanonical: true },
      }),
    ).rejects.toThrow();
  });

  it('keeps SKU identity, retained catalog rows, and activated prices immutable', async () => {
    await seedPhase3Commerce(prisma);
    const variant = await prisma.productVariant.findFirstOrThrow();
    const product = await prisma.product.findFirstOrThrow();
    const price = await prisma.variantPrice.findFirstOrThrow();

    await expect(
      prisma.productVariant.update({
        where: { id: variant.id },
        data: { sku: `${variant.sku}-CHANGED` },
      }),
    ).rejects.toThrow();
    await expect(prisma.product.delete({ where: { id: product.id } })).rejects.toThrow();
    await expect(
      prisma.variantPrice.update({
        where: { id: price.id },
        data: { amountMinor: price.amountMinor + 1n },
      }),
    ).rejects.toThrow();
  });

  it('permits only one active version for a price book', async () => {
    await seedPhase3Commerce(prisma);
    const priceBook = await prisma.priceBook.findUniqueOrThrow({
      where: { code: 'US-RETAIL' },
    });

    await expect(
      prisma.priceBookVersion.create({
        data: {
          priceBookId: priceBook.id,
          version: 2,
          lifecycle: PriceBookVersionLifecycle.ACTIVE,
          effectiveFrom: new Date(),
          activatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('enforces conserved non-negative balances and exact optimistic revisions', async () => {
    await seedPhase3Commerce(prisma);
    const balance = await prisma.inventoryBalance.findFirstOrThrow();

    await expect(
      prisma.inventoryBalance.update({
        where: { id: balance.id },
        data: { reserved: balance.onHand + 1, version: { increment: 1 } },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryBalance.update({
        where: { id: balance.id },
        data: { version: { increment: 2 } },
      }),
    ).rejects.toThrow();

    const updated = await prisma.inventoryBalance.update({
      where: { id: balance.id },
      data: { reserved: 1, version: { increment: 1 } },
    });
    expect(updated).toMatchObject({ reserved: 1, version: 2 });
  });

  it('accepts a matching movement snapshot and rejects movement history mutation', async () => {
    await seedPhase3Commerce(prisma);
    const balance = await prisma.inventoryBalance.findFirstOrThrow();

    const updated = await prisma.inventoryBalance.update({
      where: { id: balance.id },
      data: { reserved: 1, version: { increment: 1 } },
    });
    const movement = await prisma.inventoryMovement.create({
      data: {
        warehouseId: updated.warehouseId,
        variantId: updated.variantId,
        type: InventoryMovementType.RESERVED,
        reservedDelta: 1,
        resultingOnHand: updated.onHand,
        resultingReserved: updated.reserved,
        resultingAllocated: updated.allocated,
        resultingDamaged: updated.damaged,
        commandId: randomUUID(),
        actorType: AuditActorType.SYSTEM,
        actorId: 'system:inventory-integration',
        reason: 'Prove reservation movement persistence.',
      },
    });

    await expect(
      prisma.inventoryMovement.update({
        where: { id: movement.id },
        data: { reason: 'Rewrite inventory history.' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryMovement.create({
        data: {
          warehouseId: updated.warehouseId,
          variantId: updated.variantId,
          type: InventoryMovementType.RESERVED,
          reservedDelta: 1,
          resultingOnHand: updated.onHand,
          resultingReserved: updated.reserved + 1,
          resultingAllocated: updated.allocated,
          resultingDamaged: updated.damaged,
          commandId: randomUUID(),
          actorType: AuditActorType.SYSTEM,
          actorId: 'system:inventory-integration',
          reason: 'Attempt a movement that disagrees with the balance.',
        },
      }),
    ).rejects.toThrow();
  });
});
