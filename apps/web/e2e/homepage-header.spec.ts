import { expect, test } from '@playwright/test';
import { mockCatalog } from './catalog-fixture';

test.describe('homepage storefront header', () => {
  test('provides storefront navigation, catalog search, and an accessible mobile menu', async ({
    page,
  }) => {
    await mockCatalog(page);
    const browserErrors: string[] = [];
    const failedResources: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400) failedResources.push(`${response.status()} ${response.url()}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error' && /hydration|hydrated/iu.test(message.text())) {
        browserErrors.push(message.text());
      }
    });
    await page.goto('/');
    await page.waitForTimeout(200);

    const header = page.locator('header');
    await expect(header.getByRole('link', { name: 'PULSE//FIELD' })).toHaveAttribute('href', '/');
    await expect(header.getByRole('link', { name: 'Shop' }).first()).toHaveAttribute(
      'href',
      '/catalog',
    );
    await expect(header.getByRole('link', { name: 'Running' }).first()).toHaveAttribute(
      'href',
      '/catalog?category=running',
    );
    await expect(header.getByRole('link', { name: 'Trail' }).first()).toHaveAttribute(
      'href',
      '/catalog?category=trail',
    );
    await expect(header.getByRole('link', { name: 'Training' }).first()).toHaveAttribute(
      'href',
      '/catalog?category=training',
    );
    await expect(header.getByRole('link', { name: 'Cart' }).first()).toHaveAttribute(
      'href',
      '/cart',
    );
    await expect(header.getByRole('searchbox', { name: 'Search products' })).toHaveAttribute(
      'name',
      'search',
    );

    await page.setViewportSize({ width: 320, height: 800 });
    await expect(header.getByRole('link', { name: 'Cart' })).toBeVisible();
    const bounds = await header.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
    const menuButton = header.getByRole('button', { name: 'Menu' });
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(header.getByRole('link', { name: 'Training' }).last()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton).toBeFocused();
    expect(browserErrors).toEqual([]);
    expect(failedResources).toEqual([]);
  });

  test('hydrates storefront query destinations into catalog controls', async ({ page }) => {
    await mockCatalog(page);
    await page.goto('/catalog?search=tempo&category=running&sort=price-asc');
    await page.waitForTimeout(200);

    await expect(page.getByRole('textbox', { name: 'Search products' })).toHaveValue('tempo');
    await expect(page.getByLabel('Sort products')).toHaveValue('price-asc');
  });
});
