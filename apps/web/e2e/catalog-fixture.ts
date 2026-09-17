export const catalogFixture = {
  items: [
    {
      id: 'motion-tee',
      slug: 'motion-tee',
      name: 'Motion Tee',
      description: 'Lightweight technical training tee.',
      categories: [{ slug: 'training', name: 'Training' }],
      media: [],
      variants: [
        {
          id: 'motion-tee-black-m',
          sku: 'MOTION-TEE-BLK-M',
          name: 'Black / M',
          optionValues: { color: 'Black', size: 'M' },
          priceMinor: 4800,
          currency: 'USD',
          available: 8,
          inStock: true,
        },
      ],
      available: 8,
      inStock: true,
      currency: 'USD',
    },
    {
      id: 'pace-short',
      slug: 'pace-short',
      name: 'Pace Short',
      description: 'Unrestricted running short.',
      categories: [{ slug: 'running', name: 'Running' }],
      media: [],
      variants: [
        {
          id: 'pace-short-black-m',
          sku: 'PACE-SHORT-BLK-M',
          name: 'Black / M',
          optionValues: { color: 'Black', size: 'M' },
          priceMinor: 5800,
          currency: 'USD',
          available: 5,
          inStock: true,
        },
      ],
      available: 5,
      inStock: true,
      currency: 'USD',
    },
    {
      id: 'ridge-shell',
      slug: 'ridge-shell',
      name: 'Ridge Shell',
      description: 'Weather-ready trail layer.',
      categories: [{ slug: 'trail', name: 'Trail' }],
      media: [],
      variants: [
        {
          id: 'ridge-shell-black-m',
          sku: 'RIDGE-SHELL-BLK-M',
          name: 'Black / M',
          optionValues: { color: 'Black', size: 'M' },
          priceMinor: 12800,
          currency: 'USD',
          available: 2,
          inStock: true,
        },
      ],
      available: 2,
      inStock: true,
      currency: 'USD',
    },
    {
      id: 'daily-layer',
      slug: 'daily-layer',
      name: 'Daily Layer',
      description: 'Everyday performance layer.',
      categories: [{ slug: 'training', name: 'Training' }],
      media: [],
      variants: [
        {
          id: 'daily-layer-graphite-m',
          sku: 'DAILY-LAYER-GRA-M',
          name: 'Graphite / M',
          optionValues: { color: 'Graphite', size: 'M' },
          priceMinor: 6800,
          currency: 'USD',
          available: 0,
          inStock: false,
        },
      ],
      available: 0,
      inStock: false,
      currency: 'USD',
    },
  ],
  page: 1,
  pageSize: 12,
  totalItems: 4,
  totalPages: 1,
};

export async function mockCatalog(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/v1/catalog/products*', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: catalogFixture });
  });
}
