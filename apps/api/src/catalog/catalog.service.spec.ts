import type { PrismaService } from '../database/prisma.service';
import { CatalogAvailability, CatalogQueryDto, CatalogSort } from './catalog.dto';
import { CatalogService } from './catalog.service';

function productRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    name: 'Aero Tempo Tee',
    description: 'Purpose-built for road running.',
    status: 'ACTIVE',
    slugs: [
      {
        id: '40000000-0000-4000-8000-000000000001',
        productId: '20000000-0000-4000-8000-000000000001',
        slug: 'aero-tempo-tee-old',
        isCanonical: false,
        createdAt: new Date(),
      },
      {
        id: '40000000-0000-4000-8000-000000000002',
        productId: '20000000-0000-4000-8000-000000000001',
        slug: 'aero-tempo-tee',
        isCanonical: true,
        createdAt: new Date(),
      },
    ],
    variants: [
      {
        id: '30000000-0000-4000-8000-000000000001',
        productId: '20000000-0000-4000-8000-000000000001',
        sku: 'PF-AERO-BLU-M',
        name: 'Aero Tempo Tee — M',
        optionValues: { size: 'M', color: 'Signal Blue' },
        prices: [
          {
            amountMinor: 4800n,
            priceBookVersion: { priceBook: { currencyCode: 'USD' } },
          },
        ],
        inventoryBalances: [{ onHand: 5, reserved: 1, allocated: 0, damaged: 0 }],
      },
    ],
    categories: [{ position: 0, category: { name: 'Running', slug: 'running' } }],
    media: [
      {
        storageKey: 'catalog/seed/aero-tempo-tee.svg',
        altText: 'Aero Tempo Tee in Signal Blue',
        width: 1600,
        height: 1200,
      },
    ],
    ...overrides,
  };
}

describe('CatalogService', () => {
  const count = jest.fn();
  const findMany = jest.fn();
  const findUnique = jest.fn();
  const service = new CatalogService({
    product: { count, findMany },
    productSlug: { findUnique },
  } as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps server-owned USD price and derived US availability', async () => {
    count.mockResolvedValue(1);
    findMany.mockResolvedValue([productRecord()]);

    const result = await service.list(Object.assign(new CatalogQueryDto(), { pageSize: 12 }));

    expect(result.items[0]).toMatchObject({
      slug: 'aero-tempo-tee',
      currency: 'USD',
      available: 4,
      inStock: true,
      media: [{ url: '/catalog/seed/aero-tempo-tee.svg' }],
      variants: [{ priceMinor: 4800, available: 4, inStock: true }],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 500,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('filters availability after deriving it from warehouse balances', async () => {
    count.mockResolvedValue(2);
    findMany.mockResolvedValue([
      productRecord(),
      productRecord({
        id: '20000000-0000-4000-8000-000000000002',
        name: 'Unavailable product',
        variants: [
          {
            id: '30000000-0000-4000-8000-000000000002',
            productId: '20000000-0000-4000-8000-000000000002',
            sku: 'PF-OUT-001',
            name: 'Unavailable product — M',
            optionValues: { size: 'M', color: 'Black' },
            prices: [
              { amountMinor: 4800n, priceBookVersion: { priceBook: { currencyCode: 'USD' } } },
            ],
            inventoryBalances: [{ onHand: 1, reserved: 1, allocated: 0, damaged: 0 }],
          },
        ],
      }),
    ]);

    const query = Object.assign(new CatalogQueryDto(), {
      availability: CatalogAvailability.IN_STOCK,
      sort: CatalogSort.PRICE_ASC,
    });
    const result = await service.list(query);

    expect(result.totalItems).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.inStock).toBe(true);
  });

  it('resolves historical slugs to the active product canonical slug', async () => {
    findUnique.mockResolvedValue({ product: productRecord() });

    await expect(service.getBySlug('aero-tempo-tee-old')).resolves.toMatchObject({
      canonicalSlug: 'aero-tempo-tee',
      product: { slug: 'aero-tempo-tee' },
    });
  });

  it('rejects malformed slugs before querying the database', async () => {
    await expect(service.getBySlug('../private-file')).rejects.toThrow();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does not expose active products without a usable US/USD variant', async () => {
    count.mockResolvedValue(1);
    findMany.mockResolvedValue([
      productRecord({
        variants: [
          {
            id: '30000000-0000-4000-8000-000000000001',
            productId: '20000000-0000-4000-8000-000000000001',
            sku: 'PF-AERO-BLU-M',
            name: 'Aero Tempo Tee — M',
            optionValues: { size: 'M', color: 'Signal Blue' },
            prices: [],
            inventoryBalances: [],
          },
        ],
      }),
    ]);

    const result = await service.list(new CatalogQueryDto());

    expect(result.items).toEqual([]);
  });
});
