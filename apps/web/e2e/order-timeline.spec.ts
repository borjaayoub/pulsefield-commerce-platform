import { expect, test } from '@playwright/test';

const reference = 'PF-TEST00000001';
const timeline = {
  orderReference: reference,
  status: 'confirmed',
  fulfillmentProgress: 'PARTIALLY_SHIPPED',
  currency: 'USD',
  subtotalMinor: 1000,
  shippingMinor: 0,
  taxMinor: 80,
  totalMinor: 1080,
  lines: [],
  events: [],
  shipments: [
    {
      ordinal: 1,
      total: 2,
      status: 'SHIPPED',
      items: [{ productName: 'Sprint Tee', variantName: 'Blue / M', quantity: 2 }],
      carrierCode: 'UPS',
      trackingReference: 'TRACK-1',
    },
    {
      ordinal: 2,
      total: 2,
      status: 'PACKED',
      items: [{ productName: 'Trail Short', variantName: 'Black / L', quantity: 1 }],
      carrierCode: null,
      trackingReference: null,
    },
  ],
  accessExpiresAt: '2026-10-14T00:00:00.000Z',
};

test.describe('guest order timeline shipments', () => {
  test('shows safe, ordinal shipment groups at a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.route(`**/api/v1/orders/${reference}/timeline`, async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(timeline) });
    });
    await page.goto(`/orders/${reference}#access=test-token`);

    await expect(page.getByText('PARTIALLY SHIPPED')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shipments' })).toBeVisible();
    await expect(page.getByText('Shipment 1 of 2 · SHIPPED')).toBeVisible();
    await expect(page.getByText('Sprint Tee · Blue / M × 2')).toBeVisible();
    await expect(page.getByText('UPS · TRACK-1')).toBeVisible();
    await expect(page.getByText('Shipment 2 of 2 · PACKED')).toBeVisible();
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth),
    ).toBe(true);
  });

  test('preserves the unavailable state when guest access is expired or revoked', async ({
    page,
  }) => {
    await page.route(`**/api/v1/orders/${reference}/timeline`, async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{}' });
    });
    await page.goto(`/orders/${reference}#access=expired-token`);

    await expect(
      page.getByRole('heading', { name: 'This order link is unavailable.' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to catalog →' })).toBeVisible();
  });

  test('refreshes the fulfillment queue after a stale-version conflict', async ({ page }) => {
    let fulfillmentReads = 0;
    await page.route('**/api/v1/auth/sessions/current', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'staff-1', email: 'fulfiller@example.test', roles: ['FULFILLER'] },
          csrfToken: 'csrf-token',
        }),
      });
    });
    await page.route('**/api/v1/staff/operations/fulfillment?*', async (route) => {
      fulfillmentReads += 1;
      const version = fulfillmentReads === 1 ? 2 : 3;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'group-1',
              orderReference: reference,
              orderFulfillmentProgress: 'PREPARING',
              warehouseCode: 'US-EAST-01',
              status: fulfillmentReads === 1 ? 'PACKED' : 'SHIPPED',
              version,
              etag: `"fulfillment-${version}"`,
              carrierCode: null,
              trackingReference: null,
              items: [{ sku: 'TEE-BLUE-M', productName: 'Sprint Tee', quantity: 1 }],
              createdAt: '2026-09-30T12:00:00.000Z',
              updatedAt: '2026-09-30T12:00:00.000Z',
              pickingStartedAt: '2026-09-30T12:00:00.000Z',
              packedAt: '2026-09-30T12:01:00.000Z',
              shippedAt: null,
              deliveredAt: null,
            },
          ],
          nextCursor: null,
        }),
      });
    });
    await page.route('**/api/v1/staff/fulfillment-groups/group-1/transitions', async (route) => {
      expect(await route.request().headerValue('if-match')).toBe('"fulfillment-2"');
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify({ code: 'FULFILLMENT_REVISION_CONFLICT', currentVersion: 3 }),
      });
    });
    await page.goto('/operations');

    await expect(page.getByRole('button', { name: 'Advance' })).toBeVisible();
    await page.getByRole('button', { name: 'Advance' }).click();
    await expect(
      page.getByText('This fulfillment group changed. The queue has been refreshed.'),
    ).toBeVisible();
    await expect(page.locator('tbody')).toContainText('SHIPPED');
    expect(fulfillmentReads).toBeGreaterThanOrEqual(2);
  });
});
