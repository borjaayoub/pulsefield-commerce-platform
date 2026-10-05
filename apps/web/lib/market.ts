import type { InternationalMarketCode, SupportedCurrency } from '@pulse-field/contracts';

export const MARKETS = ['US', 'MA', 'EU', 'UK'] as const;
export const MARKET_LABELS: Record<InternationalMarketCode, string> = {
  US: 'United States · USD',
  MA: 'Morocco · MAD',
  EU: 'European Union · EUR',
  UK: 'United Kingdom · GBP',
};
export function parseMarket(value: string | null): InternationalMarketCode {
  return MARKETS.find((market) => market === value) ?? 'US';
}
export function marketUrl(path: string, market: InternationalMarketCode): string {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('market', market);
  return `${pathname}?${params}`;
}
export function formatMoney(amount: number, currency: SupportedCurrency): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
  }).format(amount / 100);
}
export const DESTINATIONS = {
  US: 'United States',
  MA: 'Morocco',
  GB: 'United Kingdom',
  AT: 'Austria',
  BE: 'Belgium',
  BG: 'Bulgaria',
  HR: 'Croatia',
  CY: 'Cyprus',
  CZ: 'Czechia',
  DK: 'Denmark',
  EE: 'Estonia',
  FI: 'Finland',
  FR: 'France',
  DE: 'Germany',
  GR: 'Greece',
  HU: 'Hungary',
  IE: 'Ireland',
  IT: 'Italy',
  LV: 'Latvia',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  MT: 'Malta',
  NL: 'Netherlands',
  PL: 'Poland',
  PT: 'Portugal',
  RO: 'Romania',
  SK: 'Slovakia',
  SI: 'Slovenia',
  ES: 'Spain',
  SE: 'Sweden',
} as const;
export type Destination = keyof typeof DESTINATIONS;
export function destinationMarket(country: Destination): InternationalMarketCode {
  return country === 'US' ? 'US' : country === 'MA' ? 'MA' : country === 'GB' ? 'UK' : 'EU';
}
