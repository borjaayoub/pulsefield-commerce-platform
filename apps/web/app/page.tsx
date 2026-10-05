import { StorefrontShell } from '../components/storefront-shell';
import { HomepageStorefront } from '../components/homepage-storefront';
import type { Metadata } from 'next';
import { availableMarkets } from '../lib/catalog.server';
import { parseMarket } from '../lib/market';
import { regionalMetadata } from '../lib/seo';
import type { PublicSearchParams } from './catalog/page';

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
    '/',
    market,
    'Built for movement',
    'Technical gear for running, trail and training. Regional fixed prices exclude simulated tax.',
    await availableMarkets(),
  );
}

export default function HomePage() {
  return (
    <StorefrontShell>
      <HomepageStorefront />
    </StorefrontShell>
  );
}
