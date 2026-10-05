import { expect, test } from '@playwright/test';

test.beforeEach(() => {
  if (
    !/^phase64_browser_[a-f0-9]{32}_test$/u.test(process.env.PHASE6_ACCEPTANCE_DATABASE_NAME ?? '')
  )
    throw new Error('Use the guarded Phase 6 browser runner.');
});

for (const [market, currency] of [
  ['US', 'USD'],
  ['MA', 'MAD'],
  ['EU', 'EUR'],
  ['UK', 'GBP'],
]) {
  test(`server HTML and disabled-JavaScript product evidence for ${market}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const api = await context.request.get(
        `http://localhost:4000/api/v1/catalog/products/aero-tempo-tee?market=${market}`,
      );
      expect(api.ok()).toBe(true);
      const product = await api.json();
      const response = await page.goto(
        `http://localhost:3000/catalog/aero-tempo-tee?market=${market}&utm_source=demo`,
      );
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: product.name })).toBeVisible();
      await expect(page.locator('main')).toContainText(currency);
      await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute(
        'href',
        `http://localhost:3000/catalog/aero-tempo-tee?market=${market}`,
      );
      await expect(page.locator('head meta[property="og:url"]')).toHaveAttribute(
        'content',
        `http://localhost:3000/catalog/aero-tempo-tee?market=${market}`,
      );
      await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', /noindex/u);
      const links = await page
        .locator('head link[rel="alternate"][hreflang]')
        .evaluateAll((elements) =>
          Object.fromEntries(
            elements.map((element) => [
              element.getAttribute('hreflang'),
              element.getAttribute('href'),
            ]),
          ),
        );
      expect(Object.keys(links)).toHaveLength(32);
      expect(links['en-FR']).toBe('http://localhost:3000/catalog/aero-tempo-tee?market=EU');
      expect(links['en-GB']).toBe('http://localhost:3000/catalog/aero-tempo-tee?market=UK');
      expect(links['x-default']).toBe('http://localhost:3000/catalog/aero-tempo-tee?market=US');
      const script = page.locator('script[type="application/ld+json"]');
      const ld = JSON.parse((await script.textContent()) ?? '{}');
      expect(ld.name).toBe(product.name);
      expect(ld.description).toBe(product.description);
      expect(ld.offers).toHaveLength(product.variants.length);
      for (const [index, offer] of ld.offers.entries()) {
        expect(offer.priceCurrency).toBe(currency);
        expect(offer.price).toBe((product.variants[index].priceMinor / 100).toFixed(2));
        expect(offer.availability).toBe(
          product.variants[index].inStock
            ? 'https://schema.org/InStock'
            : 'https://schema.org/OutOfStock',
        );
      }
      const nonce = await script.evaluate((element) => (element as HTMLScriptElement).nonce);
      expect(nonce).not.toBe('');
      expect(response?.headers()['content-security-policy']).toContain(`'nonce-${nonce}'`);
      const raw = await context.request.get(
        `http://localhost:3000/catalog/aero-tempo-tee?market=${market}`,
      );
      expect(await raw.text()).toContain('id="product-name">Aero Tempo Tee</h1>');
    } finally {
      await context.close();
    }
  });
}

test('public canonical metadata, sitemap coverage and private-route exclusion', async ({
  page,
}) => {
  for (const market of ['US', 'MA', 'EU', 'UK'])
    for (const path of ['/', '/catalog']) {
      await page.goto(`${path}?market=${market}&search=ignored&utm_source=demo`);
      await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute(
        'href',
        `http://localhost:3000${path}?market=${market}`,
      );
      await expect(page.locator('head link[rel="alternate"][hreflang]')).toHaveCount(32);
    }
  const response = await page.request.get('/sitemap.xml');
  expect(response.ok()).toBe(true);
  const xml = await response.text();
  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/gu)].map((match) =>
    match[1].replaceAll('&amp;', '&'),
  );
  expect(urls).toHaveLength(56);
  expect(new Set(urls).size).toBe(56);
  for (const url of urls)
    expect(new URL(url).pathname).toMatch(/^\/(?:catalog(?:\/[a-z0-9-]+)?)?$/u);
  expect(xml).not.toMatch(/checkout|operations|orders|access=|session|customerEmail/u);
  expect(await (await page.request.get('/robots.txt')).text()).toContain('Disallow: /');
  for (const path of ['/cart', '/checkout', '/orders/PF-NONEXISTENT', '/operations/sign-in']) {
    await page.goto(path);
    await expect(
      page.locator(
        'head link[rel="canonical"], head link[hreflang], script[type="application/ld+json"]',
      ),
    ).toHaveCount(0);
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', /noindex/u);
  }
});

test('historical redirects preserve market and missing products emit no offers', async ({
  page,
}) => {
  const redirect = await page.request.get('/catalog/phase64-old-aero?market=MA', {
    maxRedirects: 0,
  });
  expect(redirect.status()).toBe(308);
  expect(redirect.headers().location).toBe('/catalog/aero-tempo-tee?market=MA');
  const missing = await page.request.get('/catalog/phase64-missing?market=UK');
  expect(missing.status()).toBe(404);
  expect(await missing.text()).not.toContain('application/ld+json');
  await page.goto('/catalog/aero-tempo-tee');
  await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute(
    'href',
    'http://localhost:3000/catalog/aero-tempo-tee?market=US',
  );
});
