import { readCatalog, readProduct, validProduct } from './catalog.server';
import { catalogFixture } from '../e2e/catalog-fixture';

describe('public catalog server reader', () => {
  afterEach(() => jest.restoreAllMocks());
  it('rejects mixed currency, invalid amounts and unsafe media before offers/rendering', () => {
    const product = catalogFixture.items[0];
    expect(validProduct(product, 'US')).toBe(true);
    expect(validProduct(product, 'MA')).toBe(false);
    expect(
      validProduct({ ...product, variants: [{ ...product.variants[0], priceMinor: -1 }] }, 'US'),
    ).toBe(false);
    expect(
      validProduct(
        { ...product, media: [{ url: '//remote.test/a.png', altText: 'x', width: 1, height: 1 }] },
        'US',
      ),
    ).toBe(false);
  });
  it('fetches public data without cookies, credentials, caching or automatic redirects', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(catalogFixture.items[0])));
    expect(await readProduct('motion-tee', 'US')).toMatchObject({ kind: 'ready' });
    expect(fetch.mock.calls[0][0].toString()).toBe(
      'http://localhost:4000/api/v1/catalog/products/motion-tee?market=US',
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      cache: 'no-store',
      redirect: 'manual',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
  });
  it('follows only a validated canonical slug on the fixed catalog origin', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ canonicalSlug: '//evil.test' }), { status: 301 }),
      );
    expect(await readProduct('old-slug', 'US')).toEqual({ kind: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('distinguishes missing products from unavailable/malformed configuration without invented data', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...catalogFixture,
            market: 'MA',
            currency: 'USD',
            taxTreatment: 'exclusive',
            pageSize: 48,
          }),
        ),
      );
    expect(await readProduct('missing', 'US')).toEqual({ kind: 'missing' });
    expect(await readProduct('unavailable', 'US')).toEqual({ kind: 'unavailable' });
    expect(await readCatalog('MA')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
