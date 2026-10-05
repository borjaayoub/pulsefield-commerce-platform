import { languageAlternates, localOrigin, productJsonLd, publicUrl, safeJsonLd } from './seo';
import { catalogFixture } from '../e2e/catalog-fixture';
import type { CatalogProduct } from '../app/catalog/catalog-types';

describe('regional SEO privacy and presentation', () => {
  it('canonicalizes public routes without tracking, filters, credentials or host input', () => {
    expect(publicUrl('/catalog?market=MA&search=private#access=secret', 'EU')).toBe(
      'http://localhost:3000/catalog?market=EU',
    );
    for (const path of [
      '/cart',
      '/checkout',
      '/orders/reference',
      '/operations',
      '//evil.test/catalog',
      'https://evil.test',
    ])
      expect(() => publicUrl(path, 'US')).toThrow();
  });
  it.each([
    'https://remote.test',
    'http://user:password@localhost:3000',
    'http://localhost:3000/path',
    'http://localhost:3000?secret=value',
    'ftp://localhost',
  ])('rejects unsafe configured origin %s', (value) => {
    expect(() => localOrigin(value, 'http://localhost:3000')).toThrow();
  });
  it('permits local host/Compose API origins without using them as canonical origins', () => {
    expect(localOrigin('http://api:4000', 'http://localhost:4000', true)).toBe('http://api:4000');
    expect(() => localOrigin('http://api:4000', 'http://localhost:3000')).toThrow();
  });
  it('uses real English destination codes and only resolved markets', () => {
    const languages = languageAlternates('/catalog', ['US', 'MA', 'EU', 'UK']);
    expect(Object.keys(languages)).toHaveLength(32);
    expect(languages['en-FR']).toBe('http://localhost:3000/catalog?market=EU');
    expect(languages['en-GB']).toBe('http://localhost:3000/catalog?market=UK');
    expect(languages['en-MA']).toBe('http://localhost:3000/catalog?market=MA');
    expect(languages['en-EU']).toBeUndefined();
    expect(languages['en-UK']).toBeUndefined();
    expect(languageAlternates('/catalog', ['MA'])).toEqual({
      'en-MA': 'http://localhost:3000/catalog?market=MA',
    });
  });
  it('escapes script termination without changing product data or original offer money', () => {
    const product: CatalogProduct = {
      ...catalogFixture.items[0],
      market: 'MA',
      currency: 'MAD',
      taxTreatment: 'exclusive',
      description: '</script><script>alert(1)</script>',
      variants: [
        {
          ...catalogFixture.items[0].variants[0],
          currency: 'MAD',
          priceMinor: 48000,
          inStock: false,
        },
      ],
    };
    const json = safeJsonLd(productJsonLd(product));
    expect(json).not.toContain('<');
    const value = JSON.parse(json) as {
      description: string;
      offers: { priceCurrency: string; price: string; availability: string }[];
    };
    expect(value.description).toBe(product.description);
    expect(value.offers[0]).toMatchObject({
      priceCurrency: 'MAD',
      price: '480.00',
      availability: 'https://schema.org/OutOfStock',
    });
    expect(json).not.toContain('reporting');
  });
});
