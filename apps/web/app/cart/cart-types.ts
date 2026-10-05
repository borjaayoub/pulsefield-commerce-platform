import type { InternationalMarketCode, SupportedCurrency } from '@pulse-field/contracts';
import { API_ORIGIN, formatUsd } from '../catalog/catalog-types';

export interface CartItem {
  id: string;
  productId: string;
  productName: string;
  variantId: string;
  sku: string;
  name: string;
  optionValues: Record<string, string>;
  quantity: number;
  currentUnitPriceMinor: number | null;
  currentLinePriceMinor: number | null;
  currency: SupportedCurrency;
  available: number;
  purchasable: boolean;
  media: { url: string; altText: string; width: number; height: number } | null;
}

export interface Cart {
  market: InternationalMarketCode;
  taxTreatment: 'exclusive';
  revision: number;
  currency: SupportedCurrency;
  subtotalMinor: number | null;
  totalMinor: number | null;
  hasUnavailableItems: boolean;
  expiresAt: string;
  items: CartItem[];
}

export function cartUrl(): string {
  return `${API_ORIGIN}/api/v1/cart`;
}

export function cartQuantityLimit(available: number): number {
  return Math.min(99, Math.max(0, available));
}

export function canAdjustCartQuantity(
  item: Pick<CartItem, 'currentUnitPriceMinor' | 'available'>,
): boolean {
  return item.currentUnitPriceMinor !== null && item.available > 0;
}

export function clampCartQuantity(quantity: number, available: number): number | null {
  const limit = cartQuantityLimit(available);
  if (limit < 1 || !Number.isSafeInteger(quantity)) return null;
  return Math.min(Math.max(1, quantity), limit);
}

export { formatUsd };
