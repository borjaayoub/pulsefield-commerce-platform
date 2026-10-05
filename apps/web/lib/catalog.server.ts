import { cache } from 'react';
import type { InternationalMarketCode } from '@pulse-field/contracts';
import {
  CATALOG_SLUG_PATTERN,
  type CatalogList,
  type CatalogProduct,
} from '../app/catalog/catalog-types';
import { MARKETS } from './market';
import { localOrigin } from './seo';

const currencies = { US: 'USD', MA: 'MAD', EU: 'EUR', UK: 'GBP' } as const;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string';
export function validProduct(
  value: unknown,
  market: InternationalMarketCode,
): value is CatalogProduct {
  if (
    !record(value) ||
    value.market !== market ||
    value.currency !== currencies[market] ||
    value.taxTreatment !== 'exclusive' ||
    !text(value.id) ||
    !text(value.slug) ||
    !CATALOG_SLUG_PATTERN.test(value.slug) ||
    !text(value.name) ||
    !text(value.description) ||
    !integer(value.available) ||
    typeof value.inStock !== 'boolean' ||
    !Array.isArray(value.categories) ||
    !Array.isArray(value.media) ||
    !Array.isArray(value.variants) ||
    value.variants.length === 0
  )
    return false;
  return (
    value.categories.every(
      (category) => record(category) && text(category.slug) && text(category.name),
    ) &&
    value.media.every(
      (media) =>
        record(media) &&
        text(media.url) &&
        /^\/catalog\/[a-z0-9-]+\/[a-z0-9-]+\.(svg|webp|jpg|jpeg|png)$/u.test(media.url) &&
        text(media.altText) &&
        integer(media.width) &&
        integer(media.height),
    ) &&
    value.variants.every(
      (variant) =>
        record(variant) &&
        text(variant.id) &&
        text(variant.sku) &&
        text(variant.name) &&
        record(variant.optionValues) &&
        Object.values(variant.optionValues).every(text) &&
        variant.currency === currencies[market] &&
        integer(variant.priceMinor) &&
        integer(variant.available) &&
        typeof variant.inStock === 'boolean',
    )
  );
}
async function request(path: string): Promise<Response> {
  const origin = localOrigin(
    process.env.CATALOG_API_ORIGIN ?? process.env.NEXT_PUBLIC_API_ORIGIN,
    'http://localhost:4000',
    true,
  );
  return fetch(new URL(`/api/v1/catalog/products${path}`, origin), {
    cache: 'no-store',
    redirect: 'manual',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
}
export type ProductRead =
  { kind: 'ready'; product: CatalogProduct } | { kind: 'missing' | 'unavailable' };
export const readProduct = cache(
  async (slug: string, market: InternationalMarketCode): Promise<ProductRead> => {
    if (!CATALOG_SLUG_PATTERN.test(slug)) return { kind: 'missing' };
    try {
      let response = await request(`/${encodeURIComponent(slug)}?market=${market}`);
      if (response.status === 301) {
        const redirect: unknown = await response.json();
        if (
          !record(redirect) ||
          !text(redirect.canonicalSlug) ||
          !CATALOG_SLUG_PATTERN.test(redirect.canonicalSlug)
        )
          return { kind: 'unavailable' };
        response = await request(`/${redirect.canonicalSlug}?market=${market}`);
      }
      if (response.status === 404) return { kind: 'missing' };
      if (!response.ok) return { kind: 'unavailable' };
      const value: unknown = await response.json();
      return validProduct(value, market)
        ? { kind: 'ready', product: value }
        : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  },
);
export const readCatalog = cache(
  async (market: InternationalMarketCode, page = 1): Promise<CatalogList | null> => {
    try {
      const response = await request(`?market=${market}&pageSize=48&page=${page}&sort=name`);
      if (!response.ok) return null;
      const value: unknown = await response.json();
      if (
        !record(value) ||
        value.market !== market ||
        value.currency !== currencies[market] ||
        value.taxTreatment !== 'exclusive' ||
        !integer(value.page) ||
        value.page !== page ||
        !integer(value.pageSize) ||
        value.pageSize !== 48 ||
        !integer(value.totalPages) ||
        !integer(value.totalItems) ||
        !Array.isArray(value.items) ||
        !value.items.every((item) => validProduct(item, market))
      )
        return null;
      return {
        items: value.items,
        page: value.page,
        pageSize: value.pageSize,
        totalPages: value.totalPages,
        totalItems: value.totalItems,
      };
    } catch {
      return null;
    }
  },
);
export const availableMarkets = cache(async (): Promise<InternationalMarketCode[]> => {
  const catalogs = await Promise.all(MARKETS.map((market) => readCatalog(market)));
  return MARKETS.filter((_, index) => catalogs[index] !== null);
});
export const productMarkets = cache(async (slug: string): Promise<InternationalMarketCode[]> => {
  const products = await Promise.all(MARKETS.map((market) => readProduct(slug, market)));
  return MARKETS.filter((_, index) => {
    const result = products[index];
    return result.kind === 'ready' && result.product.slug === slug;
  });
});
