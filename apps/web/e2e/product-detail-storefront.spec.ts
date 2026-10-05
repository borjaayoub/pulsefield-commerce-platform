import { expect, test } from '@playwright/test';

test.describe('product-detail storefront', () => {
  test('selects a server-provided in-stock variant for the existing cart flow', async ({
    page,
  }) => {
    await page.goto('/catalog/aero-tempo-tee?market=US');

    await expect(page.getByRole('heading', { name: 'Aero Tempo Tee' })).toBeVisible();
    await expect(page.locator('main').getByText('Running', { exact: true })).toBeVisible();
    await expect(page.locator('input[name="variant"]:checked')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Add to cart/i })).toBeEnabled();
  });

  test('keeps product purchase controls within a small viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/catalog/aero-tempo-tee?market=US');

    await expect(page.getByRole('button', { name: /Add to cart/i })).toBeVisible();
    const dimensions = await page.locator('body').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  });
});
