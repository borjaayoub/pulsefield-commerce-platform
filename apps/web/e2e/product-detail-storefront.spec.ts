import { expect, test } from '@playwright/test';
import { catalogFixture } from './catalog-fixture';

test.describe('product-detail storefront', () => {
  test('selects a server-provided in-stock variant for the existing cart flow', async ({
    page,
  }) => {
    const product = catalogFixture.items[0];
    await page.route('**/api/v1/catalog/products/motion-tee', async (route) => {
      await route.fulfill({ contentType: 'application/json', json: product });
    });

    await page.goto('/catalog/motion-tee');

    await expect(page.getByRole('heading', { name: 'Motion Tee' })).toBeVisible();
    await expect(page.locator('main').getByText('Training', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Black / M')).toBeChecked();
    await expect(page.getByRole('button', { name: /Add to cart/i })).toBeEnabled();
  });

  test('keeps product purchase controls within a small viewport', async ({ page }) => {
    const product = catalogFixture.items[0];
    await page.route('**/api/v1/catalog/products/motion-tee', async (route) => {
      await route.fulfill({ contentType: 'application/json', json: product });
    });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/catalog/motion-tee');

    await expect(page.getByRole('button', { name: /Add to cart/i })).toBeVisible();
    const dimensions = await page.locator('body').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  });
});
