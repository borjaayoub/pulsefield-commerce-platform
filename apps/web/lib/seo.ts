import type { Metadata } from 'next';
import type { InternationalMarketCode } from '@pulse-field/contracts';
import type { CatalogProduct } from '../app/catalog/catalog-types';
import { DESTINATIONS, destinationMarket, MARKETS, MARKET_LABELS, marketUrl } from './market';

export function localOrigin(value: string | undefined, fallback: string, api = false): string {
  const url = new URL(value ?? fallback);
  const hosts = ['localhost', '127.0.0.1', '[::1]', ...(api ? ['api'] : [])];
  if (
    !hosts.includes(url.hostname) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid local commerce origin.');
  return url.origin;
}
export function webOrigin(): string {
  return localOrigin(process.env.WEB_ORIGIN, 'http://localhost:3000');
}
export function publicUrl(path: string, market: InternationalMarketCode): string {
  // Callers supply only owned public routes, never request URLs or headers.
  const pathname = path.split(/[?#]/u)[0];
  if (!/^\/(?:catalog(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?)?$/u.test(pathname))
    throw new Error('Invalid public commerce route.');
  return new URL(marketUrl(pathname, market), webOrigin()).href;
}
export function languageAlternates(
  path: string,
  markets: readonly InternationalMarketCode[],
): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const country of Object.keys(DESTINATIONS) as (keyof typeof DESTINATIONS)[]) {
    const market = destinationMarket(country);
    if (markets.includes(market)) languages[`en-${country}`] = publicUrl(path, market);
  }
  if (markets.includes('US')) {
    languages.en = publicUrl(path, 'US');
    languages['x-default'] = publicUrl(path, 'US');
  }
  return languages;
}
export function regionalMetadata(
  path: string,
  market: InternationalMarketCode,
  title: string,
  description: string,
  markets: readonly InternationalMarketCode[] = MARKETS,
): Metadata {
  const url = publicUrl(path, market);
  return {
    title: `${title} | ${MARKET_LABELS[market]} | PULSE//FIELD`,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical: url, languages: languageAlternates(path, markets) },
    openGraph: { title, description, url, siteName: 'PULSE//FIELD', type: 'website' },
  };
}
export function productJsonLd(product: CatalogProduct) {
  const url = publicUrl(`/catalog/${product.slug}`, product.market);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description,
    url,
    brand: { '@type': 'Brand', name: 'PULSE//FIELD' },
    image: product.media.map((media) => new URL(media.url, webOrigin()).href),
    offers: product.variants.map((variant) => ({
      '@type': 'Offer',
      sku: variant.sku,
      url,
      priceCurrency: variant.currency,
      price: `${BigInt(variant.priceMinor) / 100n}.${String(BigInt(variant.priceMinor) % 100n).padStart(2, '0')}`,
      availability: variant.inStock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
    })),
  };
}
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c');
}
