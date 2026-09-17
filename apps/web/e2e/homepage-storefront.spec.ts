import { expect, test } from '@playwright/test';
import { mockCatalog } from './catalog-fixture';

test.describe('homepage storefront', () => {
  test('presents the campaign hero, actual category routes, and catalog-backed selection', async ({
    page,
  }) => {
    await mockCatalog(page);
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: 'Built for the work between goals.' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Shop new arrivals/i })).toHaveAttribute(
      'href',
      '/catalog?sort=newest',
    );
    await expect(page.getByRole('heading', { name: 'New arrivals' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Motion Tee', exact: true })).toHaveAttribute(
      'href',
      '/catalog/motion-tee',
    );
    await expect(page.getByRole('link', { name: /Training Build strength/i })).toHaveAttribute(
      'href',
      '/catalog?category=training',
    );
    await expect(page.getByRole('link', { name: /Running Find the rhythm/i })).toHaveAttribute(
      'href',
      '/catalog?category=running',
    );
    await expect(page.getByRole('link', { name: /Trail Move farther/i })).toHaveAttribute(
      'href',
      '/catalog?category=trail',
    );
  });

  test('adapts the homepage without horizontal overflow on a small viewport', async ({ page }) => {
    await mockCatalog(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');

    const pageWidth = await page.locator('body').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);
    await expect(page.getByRole('heading', { name: 'Shop by purpose' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Explore the collection/i })).toBeVisible();
  });
});
