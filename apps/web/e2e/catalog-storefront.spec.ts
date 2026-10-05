import { expect, test } from '@playwright/test';
import { mockCatalog } from './catalog-fixture';

test.describe('catalog storefront', () => {
  test('uses only supported catalog filters and applies them to the existing request contract', async ({
    page,
  }) => {
    await mockCatalog(page);
    await page.goto('/catalog');

    await expect(page.getByRole('heading', { name: 'Move with intent.' })).toBeVisible();
    await expect(page.getByText('4 products')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Motion Tee' })).toHaveAttribute(
      'href',
      '/catalog/motion-tee?market=US',
    );

    await page.getByRole('button', { name: 'Filters' }).click();
    const filterDialog = page.getByRole('dialog', { name: 'Filters' });
    await expect(filterDialog).toBeVisible();
    await expect(filterDialog.getByRole('button', { name: 'Close filters' })).toBeFocused();
    await page.getByLabel('Training').check();
    await page.getByLabel('In stock').check();
    await page.getByRole('button', { name: 'Apply filters' }).click();

    await expect(page.getByLabel('Active filters')).toContainText('training');
    await expect(page.getByLabel('Active filters')).toContainText('In stock');

    await page.getByRole('button', { name: 'Filters' }).click();
    await expect(filterDialog).toBeVisible();
    await expect(filterDialog.getByRole('button', { name: 'Close filters' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(filterDialog.getByRole('button', { name: 'Apply filters' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(filterDialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Filters' })).toBeFocused();
  });

  test('stays within a 320px viewport', async ({ page }) => {
    await mockCatalog(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/catalog');

    const dimensions = await page.locator('body').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  });
});
