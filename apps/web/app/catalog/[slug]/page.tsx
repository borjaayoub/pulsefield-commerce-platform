import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import Link from 'next/link';
import { StorefrontShell } from '../../../components/storefront-shell';
import { readProduct, productMarkets } from '../../../lib/catalog.server';
import { marketUrl, parseMarket } from '../../../lib/market';
import { regionalMetadata, productJsonLd, safeJsonLd } from '../../../lib/seo';
import type { PublicSearchParams } from '../page';
import ProductClient from './product-client';

type Props = { params: Promise<{ slug: string }>; searchParams: PublicSearchParams };
async function resolve({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const market = parseMarket(
    Array.isArray(query.market) ? query.market[0] : (query.market ?? null),
  );
  const result = await readProduct(slug, market);
  if (result.kind === 'missing') notFound();
  if (result.kind === 'ready' && result.product.slug !== slug)
    permanentRedirect(marketUrl(`/catalog/${result.product.slug}`, market));
  return { result, market };
}
export async function generateMetadata(props: Props): Promise<Metadata> {
  const { result, market } = await resolve(props);
  if (result.kind !== 'ready')
    return { title: 'Product unavailable | PULSE//FIELD', robots: { index: false, follow: false } };
  const product = result.product;
  return regionalMetadata(
    `/catalog/${product.slug}`,
    market,
    product.name,
    product.description,
    await productMarkets(product.slug),
  );
}
export default async function ProductPage(props: Props) {
  const { result, market } = await resolve(props);
  if (result.kind !== 'ready')
    return (
      <StorefrontShell>
        <main>
          <section role="alert">
            <h1>Product unavailable</h1>
            <p>This market or the local catalog is temporarily unavailable.</p>
            <Link href={marketUrl('/catalog', market)}>Back to catalog</Link>
          </section>
        </main>
      </StorefrontShell>
    );
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <>
      <script
        nonce={nonce}
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(productJsonLd(result.product)) }}
      />
      <ProductClient key={`${result.product.slug}:${market}`} product={result.product} />
    </>
  );
}
