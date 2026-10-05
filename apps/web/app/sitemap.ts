import type { MetadataRoute } from 'next';
import { readCatalog } from '../lib/catalog.server';
import { MARKETS } from '../lib/market';
import { publicUrl } from '../lib/seo';

export const dynamic = 'force-dynamic';
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [];
  for (const market of MARKETS) {
    const first = await readCatalog(market);
    if (!first) continue;
    // The existing API caps pagination at 100. Do not silently publish partial coverage.
    if (first.totalPages > 100)
      throw new Error('Local sitemap catalog exceeds supported pagination.');
    const products = [...first.items];
    for (let page = 2; page <= first.totalPages; page++) {
      const next = await readCatalog(market, page);
      if (!next || next.totalPages !== first.totalPages || next.totalItems !== first.totalItems)
        throw new Error('Local sitemap catalog is temporarily unavailable.');
      products.push(...next.items);
    }
    const slugs = new Set(products.map((product) => product.slug));
    if (slugs.size !== first.totalItems)
      throw new Error('Local sitemap catalog changed during pagination.');
    entries.push({ url: publicUrl('/', market) }, { url: publicUrl('/catalog', market) });
    for (const slug of slugs) entries.push({ url: publicUrl(`/catalog/${slug}`, market) });
  }
  return entries;
}
