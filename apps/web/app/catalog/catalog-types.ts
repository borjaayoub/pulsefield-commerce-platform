export interface CatalogVariant {
  id: string;
  sku: string;
  name: string;
  optionValues: Record<string, string>;
  priceMinor: number;
  currency: 'USD';
  available: number;
  inStock: boolean;
}

export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  description: string;
  categories: Array<{ slug: string; name: string }>;
  media: Array<{ url: string; altText: string; width: number; height: number }>;
  variants: CatalogVariant[];
  available: number;
  inStock: boolean;
  currency: 'USD';
}

export interface CatalogList {
  items: CatalogProduct[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';
export const CATALOG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function formatUsd(amountMinor: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    amountMinor / 100,
  );
}
