import { expect, test, type Page } from '@playwright/test';

test.beforeEach(() => {
  if (
    !/^phase64_browser_[a-f0-9]{32}_test$/u.test(process.env.PHASE6_ACCEPTANCE_DATABASE_NAME ?? '')
  )
    throw new Error('Run through the guarded Phase 6 browser acceptance runner.');
});

async function product(page: Page, market = 'US') {
  await page.goto(`/catalog?market=${market}`);
  const heading = page.getByRole('heading', { name: 'Aero Tempo Tee' });
  await expect(heading).toBeVisible();
  await heading.getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Aero Tempo Tee' })).toBeVisible();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  if (market !== 'US') {
    await expect(page.getByRole('heading', { name: 'Review market change' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm market change' }).click();
    await expect(page.getByRole('heading', { name: 'Review market change' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Add to cart' }).click();
  }
  await expect(page.getByText('Added to cart.', { exact: true })).toBeVisible();
}
async function address(page: Page, country = 'US', postal = '94105') {
  await page.getByLabel('Email for order confirmation').fill('browser@example.test');
  await page.getByLabel('Destination country').selectOption(country);
  await page.getByLabel('Full name', { exact: true }).fill('Local Demo Buyer');
  await page.getByLabel('Address', { exact: true }).fill('1 Test Road');
  await page.getByLabel('City', { exact: true }).fill('Local City');
  if (country === 'US') await page.getByLabel('State', { exact: true }).fill('CA');
  await page.getByLabel('Postal code', { exact: true }).fill(postal);
}

test('browsing selector preserves regional navigation/search without changing the cart', async ({
  page,
}) => {
  const before = await (await page.request.get('http://localhost:4000/api/v1/cart')).json();
  await page.goto('/');
  const regionalResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/catalog/products?') &&
      new URL(response.url()).searchParams.get('market') === 'MA',
  );
  await page.getByLabel('Browsing market').selectOption('MA');
  await expect(page).toHaveURL(/market=MA/u);
  const regionalCatalog = await (await regionalResponse).json();
  expect(regionalCatalog.items[0].currency).toBe('MAD');
  await expect(
    page
      .locator('main')
      .getByRole('link', { name: regionalCatalog.items[0].name, exact: true })
      .first(),
  ).toHaveAttribute('href', /market=MA/u);
  await page.locator('header').getByRole('searchbox', { name: 'Search products' }).fill('Aero');
  await page.locator('header').getByRole('searchbox', { name: 'Search products' }).press('Enter');
  await expect(page).toHaveURL(/market=MA/u);
  await expect(page.getByRole('heading', { name: 'Aero Tempo Tee' })).toBeVisible();
  const after = await (await page.request.get('http://localhost:4000/api/v1/cart')).json();
  expect(after.market).toBe('US');
  expect(after.revision).toBe(before.revision);
  expect(after.items).toEqual(before.items);
});

for (const [market, currency, country, postal] of [
  ['US', 'USD', 'US', '94105'],
  ['MA', 'MAD', 'MA', '20000'],
  ['EU', 'EUR', 'FR', '75001'],
  ['UK', 'GBP', 'GB', 'SW1A 1AA'],
])
  test(`live ${market} catalog, explicit selection, checkout and original-currency order`, async ({
    page,
  }) => {
    await product(page, market);
    await page.goto(`/cart?market=${market}`);
    await expect(page.getByLabel('Cart market')).toHaveValue(market);
    await expect(page.locator('.cart-item-price')).toContainText(currency);
    await page.getByRole('link', { name: 'Continue to checkout' }).click();
    await address(page, country, postal);
    await page.getByRole('button', { name: 'Preview authoritative total' }).click();
    await expect(page.getByRole('button', { name: 'Place demo order' })).toBeVisible();
    await expect(page.locator('aside')).toContainText(currency);
    await page.getByRole('button', { name: 'Place demo order' }).click();
    await expect(page.getByRole('heading', { name: 'Order confirmed.' })).toBeVisible();
    await page.getByRole('link', { name: 'View order timeline' }).click();
    await expect(page.locator('.cart-total')).toBeVisible();
    await expect(page.locator('main')).toContainText(
      new RegExp(
        currency === 'USD' ? '\\$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : 'MAD',
      ),
    );
  });

test('live cancellation, stale confirmation, destination mismatch and mobile keyboard selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await product(page);
  await page.goto('/cart');
  const selector = page.getByLabel('Cart market');
  await selector.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Review market change' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel market change' }).click();
  await expect(selector).toHaveValue('US');
  await selector.selectOption('MA');
  await expect(page.getByRole('button', { name: 'Confirm market change' })).toBeVisible();
  const changed = await page.request.get('http://localhost:4000/api/v1/cart');
  const cart = await changed.json();
  const mutation = await page.request.put(
    `http://localhost:4000/api/v1/cart/items/${cart.items[0].variantId}`,
    {
      headers: { Origin: 'http://localhost:3000', 'If-Match': changed.headers().etag },
      data: { quantity: 2 },
    },
  );
  expect(mutation.ok()).toBe(true);
  await page.getByRole('button', { name: 'Confirm market change' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('changed');
  await page.getByRole('button', { name: 'Cancel market change' }).click();
  await expect(selector).toHaveValue('US');
  await page.getByRole('link', { name: 'Continue to checkout' }).click();
  await address(page, 'GB', 'SW1A 1AA');
  await page.getByRole('button', { name: 'Preview authoritative total' }).click();
  await expect(page.getByRole('heading', { name: 'Review market change' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Place demo order' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm market change' }).click();
  await page.getByLabel('Postal code', { exact: true }).fill('SW1A');
  await page.getByRole('button', { name: 'Preview authoritative total' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('Review the address');
  await expect(page.getByRole('button', { name: 'Place demo order' })).toHaveCount(0);
  await page.getByLabel('Postal code', { exact: true }).fill('SW1A 1AA');
  await page.getByRole('button', { name: 'Preview authoritative total' }).click();
  await expect(page.getByRole('button', { name: 'Place demo order' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('lost committed response retries the exact request/key and replays one real order', async ({
  page,
}) => {
  await product(page);
  await page.goto('/checkout');
  await address(page);
  await page.getByRole('button', { name: 'Preview authoritative total' }).click();
  await expect(page.getByRole('button', { name: 'Place demo order' })).toBeVisible();
  const requests: { body: string | null; key: string | undefined; etag: string | undefined }[] = [];
  let firstOrder: string | undefined;
  await page.route('**/api/v1/checkouts', async (route) => {
    const request = route.request();
    requests.push({
      body: request.postData(),
      key: request.headers()['idempotency-key'],
      etag: request.headers()['if-match'],
    });
    if (requests.length === 2) {
      await route.fulfill({ status: 503, json: { code: 'CHECKOUT_TEMPORARILY_UNAVAILABLE' } });
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    const body = await response.json();
    if (requests.length === 1) {
      firstOrder = body.orderId;
      await route.abort('failed');
    } else {
      expect(body.orderId).toBe(firstOrder);
      await route.fulfill({ response });
    }
  });
  await page.getByRole('button', { name: 'Place demo order' }).click();
  await expect(page.getByRole('button', { name: 'Retry same order' })).toBeVisible();
  await expect(page.getByLabel('Email for order confirmation')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry same order' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByLabel('Email for order confirmation')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry same order' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed.' })).toBeVisible();
  expect(requests).toHaveLength(3);
  expect(requests[2]).toEqual(requests[0]);
  expect(requests[1]).toEqual(requests[0]);
});

test('presentation handles missing configuration and an unavailable repriced line', async ({
  page,
}) => {
  await product(page);
  await page.goto('/cart');
  await page.route('**/api/v1/cart/market-preview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.cart.items[0].currentUnitPriceMinor = null;
    body.cart.items[0].currentLinePriceMinor = null;
    body.cart.items[0].purchasable = false;
    body.cart.subtotalMinor = null;
    await route.fulfill({ response, json: body });
  });
  await page.getByLabel('Cart market').selectOption('EU');
  await expect(page.getByRole('region', { name: 'Review market change' })).toContainText(
    'Unpriced',
  );
  await expect(page.getByRole('region', { name: 'Review market change' })).toContainText(
    'Unavailable for checkout',
  );
  await page.getByRole('button', { name: 'Cancel market change' }).click();
  await page.goto('/checkout');
  await address(page);
  await page.route('**/api/v1/checkouts/preview', (route) =>
    route.fulfill({ status: 503, json: { code: 'REGIONAL_PAYMENT_PROVIDER_UNAVAILABLE' } }),
  );
  await page.getByRole('button', { name: 'Preview authoritative total' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText(
    'Stripe supports US/USD only',
  );
  await expect(page.getByRole('button', { name: 'Place demo order' })).toHaveCount(0);
});
