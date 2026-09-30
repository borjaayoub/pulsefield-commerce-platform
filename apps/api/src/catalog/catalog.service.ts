import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  CatalogLifecycle,
  FulfillmentRegion,
  InventoryAllocationPolicyLifecycle,
  PriceBookVersionLifecycle,
  WarehouseStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import {
  CatalogAvailability,
  CATALOG_SLUG_PATTERN,
  CatalogQueryDto,
  CatalogSort,
  CatalogListDto,
  CatalogProductDto,
} from './catalog.dto';

const PUBLIC_MEDIA_ROOT = '/catalog';
const MAX_SORT_CANDIDATES = 500;
const PUBLIC_MEDIA_KEY = /^catalog\/[a-z0-9-]+\/(?:[a-z0-9-]+)\.(?:svg|webp|jpg|jpeg|png)$/u;
const US_ELIGIBLE_INVENTORY_FILTER = {
  warehouse: {
    status: WarehouseStatus.ACTIVE,
    allocationPolicyAssignments: {
      some: {
        policyVersion: {
          lifecycle: InventoryAllocationPolicyLifecycle.ACTIVE,
          policy: { code: 'US-FULFILLMENT', destinationRegion: FulfillmentRegion.US },
        },
      },
    },
  },
} satisfies Prisma.InventoryBalanceWhereInput;

const PUBLIC_INCLUDE = {
  slugs: true,
  variants: {
    where: { status: CatalogLifecycle.ACTIVE },
    include: {
      prices: {
        where: {
          priceBookVersion: {
            lifecycle: PriceBookVersionLifecycle.ACTIVE,
            priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
          },
        },
        include: { priceBookVersion: { include: { priceBook: true } } },
      },
      inventoryBalances: {
        where: US_ELIGIBLE_INVENTORY_FILTER,
      },
    },
  },
  categories: {
    where: { category: { status: CatalogLifecycle.ACTIVE } },
    include: { category: true },
  },
  media: { where: { status: CatalogLifecycle.ACTIVE }, orderBy: { position: 'asc' } },
} satisfies Prisma.ProductInclude;

type PublicProductRecord = Prisma.ProductGetPayload<{ include: typeof PUBLIC_INCLUDE }>;

type PublicVariantRecord = PublicProductRecord['variants'][number];

interface PublicProductResult {
  product: CatalogProductDto;
  canonicalSlug: string;
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: CatalogQueryDto): Promise<CatalogListDto> {
    const search = query.search?.trim();
    const category = query.category?.trim();
    const sort = query.sort ?? CatalogSort.NEWEST;
    const where: Prisma.ProductWhereInput = {
      status: CatalogLifecycle.ACTIVE,
      slugs: { some: { isCanonical: true } },
      variants: {
        some: {
          status: CatalogLifecycle.ACTIVE,
          prices: {
            some: {
              priceBookVersion: {
                lifecycle: PriceBookVersionLifecycle.ACTIVE,
                priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
              },
            },
          },
        },
      },
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(category
        ? {
            categories: {
              some: { category: { slug: category, status: CatalogLifecycle.ACTIVE } },
            },
          }
        : {}),
    };

    const [totalItems, records] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        take: MAX_SORT_CANDIDATES,
        orderBy:
          sort === CatalogSort.NAME
            ? [{ name: 'asc' }, { id: 'asc' }]
            : sort === CatalogSort.NEWEST
              ? [{ createdAt: 'desc' }, { id: 'desc' }]
              : [{ name: 'asc' }, { id: 'asc' }],
        include: PUBLIC_INCLUDE,
      }),
    ]);

    const products = records
      .map((record) => this.toPublicProduct(record))
      .filter((product): product is CatalogProductDto => product !== null);
    if (query.availability) {
      const inStock = query.availability === CatalogAvailability.IN_STOCK;
      products.splice(
        0,
        products.length,
        ...products.filter((product) => product.inStock === inStock),
      );
    }
    if (sort === CatalogSort.PRICE_ASC || sort === CatalogSort.PRICE_DESC) {
      products.sort((left, right) => {
        const leftPrice = Math.min(...left.variants.map((variant) => variant.priceMinor));
        const rightPrice = Math.min(...right.variants.map((variant) => variant.priceMinor));
        const priceComparison = leftPrice - rightPrice;
        if (priceComparison !== 0) {
          return sort === CatalogSort.PRICE_ASC ? priceComparison : -priceComparison;
        }
        return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
      });
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 12;
    const start = (page - 1) * pageSize;
    // Discovery intentionally evaluates at most MAX_SORT_CANDIDATES rows so that
    // derived availability and price sorting cannot turn a public read into an
    // unbounded database or memory operation. Report the bounded result set,
    // rather than a count that would advertise pages we cannot return.
    const effectiveTotalItems = Math.min(totalItems, products.length);
    return {
      items: products.slice(start, start + pageSize),
      page,
      pageSize,
      totalItems: effectiveTotalItems,
      totalPages: Math.ceil(effectiveTotalItems / pageSize),
    };
  }

  async getBySlug(slug: string): Promise<PublicProductResult> {
    if (slug.length > 160 || !CATALOG_SLUG_PATTERN.test(slug)) {
      throw new BadRequestException();
    }
    const requested = await this.prisma.productSlug.findUnique({
      where: { slug },
      include: { product: { include: PUBLIC_INCLUDE } },
    });
    if (!requested || requested.product.status !== CatalogLifecycle.ACTIVE) {
      throw new NotFoundException();
    }

    const canonical = requested.product.slugs.find((candidate) => candidate.isCanonical);
    if (!canonical) throw new NotFoundException();
    const product = this.toPublicProduct(requested.product);
    if (!product) throw new NotFoundException();
    return { product, canonicalSlug: canonical.slug };
  }

  private toPublicProduct(record: PublicProductRecord): CatalogProductDto | null {
    const canonical = record.slugs.find((slug) => slug.isCanonical)?.slug;
    if (!canonical) throw new NotFoundException();
    const variants = record.variants
      .map((variant) => this.toPublicVariant(variant))
      .filter((variant): variant is CatalogProductDto['variants'][number] => variant !== null);
    if (variants.length === 0) return null;
    const available = variants.reduce((total, variant) => total + variant.available, 0);
    return {
      id: record.id,
      slug: canonical,
      name: record.name,
      description: record.description,
      categories: record.categories
        .sort((left, right) => left.position - right.position)
        .map(({ category }) => ({ name: category.name, slug: category.slug })),
      media: record.media
        .filter((media) => PUBLIC_MEDIA_KEY.test(media.storageKey))
        .map((media) => ({
          url: `${PUBLIC_MEDIA_ROOT}/${media.storageKey.replace(/^catalog\//u, '')}`,
          altText: media.altText,
          width: media.width,
          height: media.height,
        })),
      variants,
      available,
      inStock: available > 0,
      currency: 'USD',
    };
  }

  private toPublicVariant(
    variant: PublicVariantRecord,
  ): CatalogProductDto['variants'][number] | null {
    const price = variant.prices[0];
    if (
      !price ||
      !price.priceBookVersion.priceBook ||
      price.priceBookVersion.priceBook.currencyCode !== 'USD'
    ) {
      return null;
    }
    const available = variant.inventoryBalances.reduce(
      (total, balance) =>
        total + balance.onHand - balance.reserved - balance.allocated - balance.damaged,
      0,
    );
    const optionValues = variant.optionValues;
    if (!optionValues || typeof optionValues !== 'object' || Array.isArray(optionValues))
      return null;
    const normalizedOptions: Record<string, string> = {};
    for (const [key, value] of Object.entries(optionValues)) {
      if (typeof value !== 'string') return null;
      normalizedOptions[key] = value;
    }
    const numericPrice = Number(price.amountMinor);
    if (!Number.isSafeInteger(numericPrice)) return null;
    return {
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      optionValues: normalizedOptions,
      priceMinor: numericPrice,
      currency: 'USD',
      available: Math.max(0, available),
      inStock: available > 0,
    };
  }
}
