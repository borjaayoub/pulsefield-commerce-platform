import { expect, test } from '@playwright/test';

test.describe('cart storefront', () => {
  test('renders safe line media and preserves checkout eligibility', async ({ page }) => {
    await page.route('**/api/v1/cart', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        headers: {
          ETag: '"cart-v2"',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Origin': 'http://localhost:3000',
          'Access-Control-Expose-Headers': 'ETag',
        },
        json: {
          revision: 2,
          market: 'US',
          taxTreatment: 'exclusive',
          currency: 'USD',
          subtotalMinor: 4800,
          totalMinor: 4800,
          hasUnavailableItems: false,
          expiresAt: '2026-10-10T00:00:00.000Z',
          items: [
            {
              id: 'line-1',
              productId: 'product-1',
              productName: 'Motion Tee',
              variantId: 'variant-1',
              sku: 'MOTION-TEE-BLK-M',
              name: 'Black / M',
              optionValues: { color: 'Black', size: 'M' },
              quantity: 1,
              currentUnitPriceMinor: 4800,
              currentLinePriceMinor: 4800,
              currency: 'USD',
              available: 8,
              purchasable: true,
              media: {
                url: '/catalog/seed/motion-tee.svg',
                altText: 'Black Motion Tee',
                width: 800,
                height: 1000,
              },
            },
          ],
        },
      });
    });
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Black Motion Tee' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Continue to checkout/i })).toHaveAttribute(
      'href',
      '/checkout?market=US',
    );
  });
});
