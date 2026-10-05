import type { Metadata } from 'next';
import CatalogClient from './catalog-client';
import { parseMarket } from '../../lib/market';
import { availableMarkets } from '../../lib/catalog.server';
import { regionalMetadata } from '../../lib/seo';

export type PublicSearchParams = Promise<Record<string, string | string[] | undefined>>;
export async function generateMetadata({
  searchParams,
}: {
  searchParams: PublicSearchParams;
}): Promise<Metadata> {
  const query = await searchParams;
  const market = parseMarket(
    Array.isArray(query.market) ? query.market[0] : (query.market ?? null),
  );
  return regionalMetadata(
    '/catalog',
    market,
    'Performance gear',
    'Browse regional performance gear. Fixed prices exclude simulated tax.',
    await availableMarkets(),
  );
}
export default function CatalogPage() {
  return <CatalogClient />;
}
