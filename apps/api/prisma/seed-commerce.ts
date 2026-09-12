import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AuditActorType,
  CatalogLifecycle,
  InventoryMovementType,
  PriceBookVersionLifecycle,
  WarehouseStatus,
} from '../src/generated/prisma/enums';
import type { PrismaClient } from '../src/generated/prisma/client';

const SEED_TIME = new Date('2026-09-10T00:00:00.000Z');
const US_PRICE_BOOK_ID = '60000000-0000-4000-8000-000000000001';
const US_PRICE_BOOK_VERSION_ID = '61000000-0000-4000-8000-000000000001';
const US_WAREHOUSE_ID = '70000000-0000-4000-8000-000000000001';
const repositoryMediaRoot = resolve(process.cwd(), 'apps/web/public/catalog/seed');
const LOCAL_MEDIA_ROOT = existsSync(repositoryMediaRoot)
  ? repositoryMediaRoot
  : resolve(process.cwd(), 'web/public/catalog/seed');

function seedUuid(group: string, index: number): string {
  return `${group}-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

const categories = [
  { id: seedUuid('10000000', 1), key: 'running', name: 'Running', slug: 'running' },
  { id: seedUuid('10000000', 2), key: 'trail', name: 'Trail', slug: 'trail' },
  { id: seedUuid('10000000', 3), key: 'training', name: 'Training', slug: 'training' },
] as const;

const productDefinitions = [
  {
    code: 'AERO',
    name: 'Aero Tempo Tee',
    slug: 'aero-tempo-tee',
    category: 'running',
    activity: 'road running',
    color: 'Signal Blue',
    colorCode: 'BLU',
    material: 'recycled performance knit',
    weightGrams: 145,
    priceMinor: 4800n,
    sizes: ['S', 'M', 'L', 'XL'],
  },
  {
    code: 'VOLT',
    name: 'Velocity Race Singlet',
    slug: 'velocity-race-singlet',
    category: 'running',
    activity: 'race day',
    color: 'Volt Lime',
    colorCode: 'LIM',
    material: 'ultralight mesh',
    weightGrams: 96,
    priceMinor: 5600n,
    sizes: ['S', 'M', 'L', 'XL'],
  },
  {
    code: 'STRD',
    name: 'Stride Compression Short',
    slug: 'stride-compression-short',
    category: 'running',
    activity: 'tempo running',
    color: 'Carbon Black',
    colorCode: 'BLK',
    material: 'four-way stretch jersey',
    weightGrams: 178,
    priceMinor: 6200n,
    sizes: ['S', 'M', 'L', 'XL'],
  },
  {
    code: 'CDNC',
    name: 'Cadence Half Tight',
    slug: 'cadence-half-tight',
    category: 'running',
    activity: 'distance running',
    color: 'Deep Navy',
    colorCode: 'NVY',
    material: 'supportive interlock',
    weightGrams: 190,
    priceMinor: 6800n,
    sizes: ['S', 'M', 'L', 'XL'],
  },
  {
    code: 'RDGE',
    name: 'Ridgeline Trail Shell',
    slug: 'ridgeline-trail-shell',
    category: 'trail',
    activity: 'technical trail',
    color: 'Storm Grey',
    colorCode: 'GRY',
    material: 'weather-resistant ripstop',
    weightGrams: 285,
    priceMinor: 14800n,
    sizes: ['S', 'M', 'L'],
  },
  {
    code: 'SMMT',
    name: 'Summit Hydration Vest',
    slug: 'summit-hydration-vest',
    category: 'trail',
    activity: 'ultra trail',
    color: 'Mesa Orange',
    colorCode: 'ORG',
    material: 'breathable utility mesh',
    weightGrams: 320,
    priceMinor: 12600n,
    sizes: ['S', 'M', 'L'],
  },
  {
    code: 'TRRA',
    name: 'Terra Grip Short',
    slug: 'terra-grip-short',
    category: 'trail',
    activity: 'trail running',
    color: 'Pine Green',
    colorCode: 'GRN',
    material: 'abrasion-resistant stretch weave',
    weightGrams: 215,
    priceMinor: 7400n,
    sizes: ['S', 'M', 'L'],
  },
  {
    code: 'ALPN',
    name: 'Alpine Thermal Layer',
    slug: 'alpine-thermal-layer',
    category: 'trail',
    activity: 'cold-weather trail',
    color: 'Glacier Blue',
    colorCode: 'ICE',
    material: 'brushed thermal grid',
    weightGrams: 260,
    priceMinor: 9800n,
    sizes: ['S', 'M', 'L'],
  },
  {
    code: 'FRGE',
    name: 'Forge Training Tee',
    slug: 'forge-training-tee',
    category: 'training',
    activity: 'strength training',
    color: 'Iron Grey',
    colorCode: 'IRN',
    material: 'durable performance jersey',
    weightGrams: 175,
    priceMinor: 4400n,
    sizes: ['S', 'M', 'L'],
  },
  {
    code: 'VCTR',
    name: 'Vector Training Short',
    slug: 'vector-training-short',
    category: 'training',
    activity: 'hybrid training',
    color: 'Graphite',
    colorCode: 'GPH',
    material: 'lightweight stretch twill',
    weightGrams: 205,
    priceMinor: 5800n,
    sizes: ['S', 'M', 'L'],
  },
  {
    code: 'CORE',
    name: 'Core Stability Tight',
    slug: 'core-stability-tight',
    category: 'training',
    activity: 'mobility training',
    color: 'Plum Shadow',
    colorCode: 'PLM',
    material: 'compressive double knit',
    weightGrams: 230,
    priceMinor: 7200n,
    sizes: ['S', 'M', 'L'],
  },
  {
    code: 'RCVR',
    name: 'Recover Lightweight Hoodie',
    slug: 'recover-lightweight-hoodie',
    category: 'training',
    activity: 'recovery',
    color: 'Oat Stone',
    colorCode: 'OAT',
    material: 'soft recycled fleece',
    weightGrams: 410,
    priceMinor: 8800n,
    sizes: ['S', 'M', 'L'],
  },
] as const;

const products = productDefinitions.map((definition, productIndex) => {
  const category = categories.find(({ key }) => key === definition.category);
  if (!category) throw new Error(`Unknown seed category: ${definition.category}`);

  return {
    ...definition,
    id: seedUuid('20000000', productIndex + 1),
    slugId: seedUuid('40000000', productIndex + 1),
    mediaId: seedUuid('50000000', productIndex + 1),
    categoryId: category.id,
    categoryPosition: productIndex,
  };
});

const variants = products.flatMap((product, productIndex) =>
  product.sizes.map((size, sizeIndex) => ({
    id: seedUuid(
      '30000000',
      productDefinitions
        .slice(0, productIndex)
        .reduce((total, item) => total + item.sizes.length, 0) +
        sizeIndex +
        1,
    ),
    productId: product.id,
    sku: `PF-${product.code}-${product.colorCode}-${size}`,
    name: `${product.name} — ${size}`,
    optionValues: { size, color: product.color },
    weightGrams: product.weightGrams,
    priceMinor: product.priceMinor,
  })),
);

export const PHASE_3_SEED_COUNTS = {
  products: products.length,
  variants: variants.length,
  categories: categories.length,
  media: products.length,
  priceBooks: 1,
  warehouses: 1,
} as const;

export async function seedPhase3Commerce(prisma: PrismaClient): Promise<void> {
  for (const product of products) {
    const assetPath = resolve(LOCAL_MEDIA_ROOT, `${product.slug}.svg`);
    if (!existsSync(assetPath)) {
      throw new Error(`Missing deterministic local catalog asset: ${assetPath}`);
    }
  }

  await prisma.$transaction(async (transaction) => {
    for (const category of categories) {
      await transaction.category.upsert({
        where: { id: category.id },
        create: {
          id: category.id,
          name: category.name,
          slug: category.slug,
          status: CatalogLifecycle.ACTIVE,
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME,
        },
        update: {},
      });
    }

    for (const product of products) {
      const existing = await transaction.product.findUnique({ where: { id: product.id } });
      if (!existing) {
        await transaction.product.create({
          data: {
            id: product.id,
            name: product.name,
            description: `${product.name} is purpose-built for ${product.activity}.`,
            status: CatalogLifecycle.ACTIVE,
            specificationSchemaVersion: 1,
            specifications: {
              activity: product.activity,
              fit: 'performance',
              material: product.material,
            },
            createdAt: SEED_TIME,
            updatedAt: SEED_TIME,
            slugs: {
              create: {
                id: product.slugId,
                slug: product.slug,
                isCanonical: true,
                createdAt: SEED_TIME,
              },
            },
            variants: {
              create: variants
                .filter(({ productId }) => productId === product.id)
                .map((variant) => ({
                  id: variant.id,
                  sku: variant.sku,
                  name: variant.name,
                  optionSchemaVersion: 1,
                  optionValues: variant.optionValues,
                  weightGrams: variant.weightGrams,
                  taxClass: 'apparel.standard',
                  status: CatalogLifecycle.ACTIVE,
                  createdAt: SEED_TIME,
                  updatedAt: SEED_TIME,
                })),
            },
            categories: {
              create: {
                categoryId: product.categoryId,
                position: product.categoryPosition,
                createdAt: SEED_TIME,
              },
            },
            media: {
              create: {
                id: product.mediaId,
                storageKey: `catalog/seed/${product.slug}.svg`,
                altText: `${product.name} in ${product.color}`,
                width: 1600,
                height: 1200,
                position: 0,
                status: CatalogLifecycle.ACTIVE,
                createdAt: SEED_TIME,
                updatedAt: SEED_TIME,
              },
            },
          },
        });
      } else {
        // Existing local development rows may predate Slice 3.2's checked-in
        // assets. Reconcile only the deterministic seed media metadata.
        await transaction.productMedia.update({
          where: { id: product.mediaId },
          data: {
            storageKey: `catalog/seed/${product.slug}.svg`,
            status: CatalogLifecycle.ACTIVE,
            updatedAt: SEED_TIME,
          },
        });
      }
    }

    await transaction.priceBook.upsert({
      where: { id: US_PRICE_BOOK_ID },
      create: {
        id: US_PRICE_BOOK_ID,
        code: 'US-RETAIL',
        name: 'United States retail',
        marketCode: 'US',
        currencyCode: 'USD',
        createdAt: SEED_TIME,
      },
      update: {},
    });

    const priceBookVersion = await transaction.priceBookVersion.findUnique({
      where: { id: US_PRICE_BOOK_VERSION_ID },
    });
    if (!priceBookVersion) {
      await transaction.priceBookVersion.create({
        data: {
          id: US_PRICE_BOOK_VERSION_ID,
          priceBookId: US_PRICE_BOOK_ID,
          version: 1,
          lifecycle: PriceBookVersionLifecycle.DRAFT,
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME,
        },
      });
      await transaction.variantPrice.createMany({
        data: variants.map((variant, index) => ({
          id: seedUuid('62000000', index + 1),
          priceBookVersionId: US_PRICE_BOOK_VERSION_ID,
          variantId: variant.id,
          amountMinor: variant.priceMinor,
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME,
        })),
      });
      await transaction.priceBookVersion.update({
        where: { id: US_PRICE_BOOK_VERSION_ID },
        data: {
          lifecycle: PriceBookVersionLifecycle.ACTIVE,
          effectiveFrom: SEED_TIME,
          activatedAt: SEED_TIME,
        },
      });
    }

    await transaction.warehouse.upsert({
      where: { id: US_WAREHOUSE_ID },
      create: {
        id: US_WAREHOUSE_ID,
        code: 'US-EAST-01',
        name: 'United States East',
        countryCode: 'US',
        status: WarehouseStatus.ACTIVE,
        createdAt: SEED_TIME,
        updatedAt: SEED_TIME,
      },
      update: {},
    });

    for (const [index, variant] of variants.entries()) {
      const balanceId = seedUuid('71000000', index + 1);
      const existingBalance = await transaction.inventoryBalance.findUnique({
        where: { id: balanceId },
      });
      if (existingBalance) continue;

      const onHand = 12 + (index % 5) * 3;
      await transaction.inventoryBalance.create({
        data: {
          id: balanceId,
          warehouseId: US_WAREHOUSE_ID,
          variantId: variant.id,
          onHand,
          reserved: 0,
          allocated: 0,
          damaged: 0,
          version: 1,
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME,
        },
      });
      await transaction.inventoryMovement.create({
        data: {
          id: seedUuid('72000000', index + 1),
          warehouseId: US_WAREHOUSE_ID,
          variantId: variant.id,
          type: InventoryMovementType.INITIAL_STOCK,
          onHandDelta: onHand,
          resultingOnHand: onHand,
          resultingReserved: 0,
          resultingAllocated: 0,
          resultingDamaged: 0,
          commandId: seedUuid('73000000', index + 1),
          commandSequence: 1,
          actorType: AuditActorType.SYSTEM,
          actorId: 'system:phase-3-seed',
          reason: 'Create deterministic Phase 3 opening stock.',
          occurredAt: SEED_TIME,
        },
      });
    }
  });
}
