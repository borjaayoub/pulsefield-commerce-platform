import { expect, test, type Page, type Route } from '@playwright/test';

const source = '11111111-1111-4111-8111-111111111111';
const destination = '22222222-2222-4222-8222-222222222222';
const variantA = '33333333-3333-4333-8333-333333333333';
const variantB = '44444444-4444-4444-8444-444444444444';
const transferId = '55555555-5555-4555-8555-555555555555';
const auth = {
  user: { id: 'admin-1', email: 'admin@example.test', roles: ['ADMINISTRATOR'] },
  csrfToken: 'csrf-1',
};
const balance = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  warehouseId: source,
  variantId: variantA,
  version: 3,
  onHand: 2,
  reserved: 0,
  allocated: 0,
  damaged: 0,
  available: 2,
  lowStockThreshold: 0,
  warehouseCode: 'US-EAST-01',
  sku: 'TEE-BLUE-M',
};
function transfer(status = 'IN_TRANSIT') {
  return {
    id: transferId,
    status,
    version: status === 'RECEIVED' ? 3 : status === 'REQUESTED' ? 1 : 2,
    sourceWarehouse: { code: 'US-EAST-01', name: 'East' },
    destinationWarehouse: { code: 'EU-CENTRAL-01', name: 'Central' },
    lines: [
      {
        variantId: variantA,
        quantity: 2,
        received: status === 'RECEIVED' ? 1 : null,
        damaged: status === 'RECEIVED' ? 1 : null,
        lost: status === 'RECEIVED' ? 0 : null,
        variant: { sku: 'TEE-BLUE-M', name: 'Sprint Tee' },
      },
    ],
  };
}
async function mockOperations(
  page: Page,
  options: { transferRows?: object[]; command?: (route: Route) => Promise<void> } = {},
) {
  const transferRows = options.transferRows ?? [];
  await page.route(
    '**/api/v1/auth/sessions/current',
    async (route) =>
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(auth) }),
  );
  await page.route(
    '**/api/v1/staff/operations/inventory?*',
    async (route) =>
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ items: [balance], nextCursor: null, pageScoped: true }),
      }),
  );
  await page.route(
    '**/api/v1/catalog/**',
    async (route) =>
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(
    '**/api/v1/staff/operations/inventory-transfers?*',
    async (route) =>
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ items: transferRows, nextCursor: null }),
      }),
  );
  await page.route(
    '**/api/v1/staff/operations/inventory-low-stock?*',
    async (route) =>
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ ...balance, available: 0, lowStockThreshold: 0 }],
          nextCursor: null,
        }),
      }),
  );
  await page.route(
    '**/api/v1/staff/operations/inventory-reconciliation?*',
    async (route) =>
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              balanceId: balance.id,
              mismatchCategories: [],
              actual: {
                id: balance.id,
                warehouseId: source,
                variantId: variantA,
                onHand: 2,
                reserved: 0,
                allocated: 0,
                damaged: 0,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
              ledger: { onHand: 2, reserved: 0, allocated: 0, damaged: 0 },
              business: { reserved: 0, allocated: 0 },
              transfer: {
                expected: { outbound: 0, inboundReceived: 0, inboundDamaged: 0, inboundLost: 0 },
                actual: { dispatched: 0, received: 0, damaged: 0 },
                inTransit: { sourceOutbound: 0, destinationInbound: 0 },
                movementCoverage: {
                  invalidLineCount: 0,
                  unlinkedMovementCount: 0,
                  dispatchCount: 0,
                  dispatchQuantity: 0,
                  receiptCount: 0,
                  receiptQuantity: 0,
                  damageCount: 0,
                  damageQuantity: 0,
                },
              },
            },
          ],
          nextCursor: null,
          pageScoped: true,
          scanned: 1,
          mismatchCount: 0,
          clean: true,
        }),
      }),
  );
  await page.route('**/api/v1/staff/inventory/**', async (route) => {
    if (options.command) await options.command(route);
    else
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: transferId, version: 2, etag: '"transfer-2"' }),
      });
  });
}

test.describe('inventory operations controls', () => {
  test('creates multiline transfer and records both line payloads', async ({ page }) => {
    const requests: Array<{ url: string; body: string; key: string; ifMatch: string }> = [];
    await mockOperations(page, {
      transferRows: [],
      command: async (route) => {
        const request = route.request();
        requests.push({
          url: request.url(),
          body: request.postData() ?? '',
          key: request.headers()['idempotency-key'] ?? '',
          ifMatch: request.headers()['if-match'] ?? '',
        });
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: transferId, version: 1, etag: '"transfer-1"' }),
        });
      },
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Transfers', exact: true }).click();
    await page.getByLabel('Source warehouse ID').fill(source);
    await page.getByLabel('Destination warehouse ID').fill(destination);
    await page.getByLabel('Variant UUID').fill(variantA);
    await page.getByLabel('Quantity').fill('2');
    await page.getByRole('button', { name: 'Add line' }).click();
    await page.getByLabel('Variant UUID').fill(variantB);
    await page.getByLabel('Quantity').fill('1');
    await page.getByRole('button', { name: 'Add line' }).click();
    await page.getByLabel('Operator reason').fill('Cycle count');
    await page.getByRole('button', { name: 'Request transfer' }).click();
    expect(requests).toHaveLength(1);
    expect(requests[0].url.endsWith('/transfers')).toBe(true);
    expect(JSON.parse(requests[0].body)).toEqual({
      sourceWarehouseId: source,
      destinationWarehouseId: destination,
      lines: [
        { variantId: variantA, quantity: 2 },
        { variantId: variantB, quantity: 1 },
      ],
      reason: 'Cycle count',
    });
  });
  test('dispatches a requested transfer with the exact If-Match transition', async ({ page }) => {
    const rows: object[] = [transfer('REQUESTED')];
    const requests: string[] = [];
    await mockOperations(page, {
      transferRows: rows,
      command: async (route) => {
        const body = route.request().postData() ?? '';
        requests.push(body);
        if (body.includes('IN_TRANSIT')) rows.splice(0, 1, transfer('IN_TRANSIT'));
        else {
          rows.splice(0, 1, transfer('RECEIVED'));
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      },
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Transfers', exact: true }).click();
    await page.getByLabel('Operator reason').fill('Dispatch test');
    const details = page.locator('details.operations-row').first();
    await details.locator('summary').click();
    await expect(details.locator('legend')).toContainText('quantity 2');
    const transitionRequest = page.waitForRequest(
      '**/api/v1/staff/inventory/transfers/*/transitions',
    );
    await page.getByRole('button', { name: 'Dispatch' }).click();
    expect(requests[0]).toContain('IN_TRANSIT');
    expect((await transitionRequest).headers()['if-match']).toBe('"transfer-1"');
  });
  test('receives mixed quantities and preserves per-line receipt fields', async ({ page }) => {
    const requests: string[] = [];
    await mockOperations(page, {
      transferRows: [transfer('IN_TRANSIT')],
      command: async (route) => {
        requests.push(route.request().postData() ?? '');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      },
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Transfers', exact: true }).click();
    await page.getByLabel('Operator reason').fill('Receipt test');
    const details = page.locator('details.operations-row').first();
    await details.locator('summary').click();
    const fields = details.locator('input[type="number"]');
    await fields.nth(0).fill('1');
    await fields.nth(1).fill('1');
    await fields.nth(2).fill('0');
    await page.getByRole('button', { name: 'Complete receipt' }).click();
    expect(JSON.parse(requests[0])).toEqual({
      targetStatus: 'RECEIVED',
      reason: 'Receipt test',
      lines: [{ variantId: variantA, received: 1, damaged: 1, lost: 0 }],
    });
  });
  test('rejects blank damaged and lost receipt values before POST, then accepts explicit zeros', async ({
    page,
  }) => {
    let calls = 0;
    let body = '';
    await mockOperations(page, {
      transferRows: [transfer('IN_TRANSIT')],
      command: async (route) => {
        calls += 1;
        body = route.request().postData() ?? '';
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      },
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Transfers', exact: true }).click();
    await page.getByLabel('Operator reason').fill('Receipt blank guard');
    const details = page.locator('details.operations-row').first();
    await details.locator('summary').click();
    const fields = details.locator('input[type="number"]');
    await fields.nth(0).fill('2');
    await page.getByRole('button', { name: 'Complete receipt' }).click();
    await expect(page.getByText('blank values are invalid')).toBeVisible();
    expect(calls).toBe(0);
    await fields.nth(1).fill('0');
    await fields.nth(2).fill('0');
    await page.getByRole('button', { name: 'Complete receipt' }).click();
    await expect.poll(() => calls).toBe(1);
    expect(JSON.parse(body)).toEqual({
      targetStatus: 'RECEIVED',
      reason: 'Receipt blank guard',
      lines: [{ variantId: variantA, received: 2, damaged: 0, lost: 0 }],
    });
  });
  test('retains exact uncertain command and retries with same key/body after refreshed session', async ({
    page,
  }) => {
    let calls = 0;
    const sent: Array<{ body: string; key: string; ifMatch: string; csrf: string }> = [];
    let authCalls = 0;
    await page.route('**/api/v1/auth/sessions/current', async (route) => {
      authCalls += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ...auth, csrfToken: authCalls === 1 ? 'csrf-1' : 'csrf-2' }),
      });
    });
    await mockOperations(page, {
      command: async (route) => {
        const request = route.request();
        calls += 1;
        sent.push({
          body: request.postData() ?? '',
          key: request.headers()['idempotency-key'] ?? '',
          ifMatch: request.headers()['if-match'] ?? '',
          csrf: request.headers()['x-csrf-token'] ?? '',
        });
        if (calls === 1) await route.abort();
        else await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      },
    });
    await page.unroute('**/api/v1/auth/sessions/current');
    authCalls = 0;
    await page.route('**/api/v1/auth/sessions/current', async (route) => {
      authCalls += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ...auth, csrfToken: authCalls === 1 ? 'csrf-1' : 'csrf-2' }),
      });
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await page.getByLabel('Operator reason').fill('Cycle count');
    await page.getByLabel('On-hand delta').fill('1');
    await page.getByLabel('Damaged delta').fill('0');
    await page.getByRole('button', { name: 'Apply adjustment' }).click();
    await expect(page.getByRole('button', { name: 'Retry exact inventory command' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry exact inventory command' }).click();
    await expect(page.getByText('Inventory command completed.')).toBeVisible();
    expect(calls).toBe(2);
    expect(sent[1].body).toBe(sent[0].body);
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].ifMatch).toBe(sent[0].ifMatch);
    expect(sent[1].csrf).toBe('csrf-2');
  });
  test('retains an aborted command across inventory and transfer tabs with controls disabled', async ({
    page,
  }) => {
    const sent: Array<{ body: string; key: string; ifMatch: string }> = [];
    let calls = 0;
    await mockOperations(page, {
      command: async (route) => {
        const request = route.request();
        sent.push({
          body: request.postData() ?? '',
          key: request.headers()['idempotency-key'] ?? '',
          ifMatch: request.headers()['if-match'] ?? '',
        });
        calls += 1;
        if (calls === 1) await route.abort();
        else await route.fulfill({ status: 200, body: '{}' });
      },
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await page.getByLabel('Operator reason').fill('Tab persistence');
    await page.getByLabel('On-hand delta').fill('1');
    await page.getByLabel('Damaged delta').fill('0');
    await page.getByRole('button', { name: 'Apply adjustment' }).click();
    await expect(page.getByRole('button', { name: 'Retry exact inventory command' })).toBeVisible();
    const firstBody = sent[0];
    await page.getByRole('button', { name: 'Transfers', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Request transfer' })).toBeDisabled();
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply adjustment' })).toBeDisabled();
    await page.getByRole('button', { name: 'Retry exact inventory command' }).click();
    await expect(page.getByText('Inventory command completed.')).toBeVisible();
    expect(sent[1]).toEqual(firstBody);
  });
  test('clears stale command and uses refreshed version with a new key', async ({ page }) => {
    let calls = 0;
    const sent: Array<{ key: string; ifMatch: string }> = [];
    await mockOperations(page, {
      command: async (route) => {
        const request = route.request();
        calls += 1;
        sent.push({
          key: request.headers()['idempotency-key'] ?? '',
          ifMatch: request.headers()['if-match'] ?? '',
        });
        if (calls === 1)
          await route.fulfill({
            status: 409,
            contentType: 'application/problem+json',
            body: JSON.stringify({ code: 'INVENTORY_REVISION_CONFLICT', currentVersion: 4 }),
          });
        else await route.fulfill({ status: 200, body: '{}' });
      },
    });
    await page.unroute('**/api/v1/staff/operations/inventory?*');
    let reads = 0;
    await page.route(
      '**/api/v1/staff/operations/inventory?*',
      async (route) =>
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [{ ...balance, version: reads++ === 0 ? 3 : 4 }],
            nextCursor: null,
            pageScoped: true,
          }),
        }),
    );
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply adjustment' })).toBeEnabled();
    await page.getByLabel('Operator reason').fill('Stale refresh');
    await page.getByLabel('On-hand delta').fill('1');
    await page.getByLabel('Damaged delta').fill('0');
    await page.getByRole('button', { name: 'Apply adjustment' }).click();
    await expect(page.getByText('resource changed')).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Transfers', exact: true }).click();
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply adjustment' })).toBeEnabled();
    await page.getByLabel('Operator reason').fill('Fresh command');
    await page.getByLabel('On-hand delta').fill('2');
    await page.getByLabel('Damaged delta').fill('0');
    await page.getByRole('button', { name: 'Apply adjustment' }).click();
    await expect.poll(() => calls).toBe(2);
    expect(sent[0].ifMatch).toBe('"inventory-3"');
    expect(sent[1].ifMatch).toBe('"inventory-4"');
    expect(sent[1].key).not.toBe(sent[0].key);
  });
  for (const [status, text] of [
    [401, 'sign-in'],
    [403, 'recent MFA'],
  ] as const)
    test(`shows ${status} command authentication guidance`, async ({ page }) => {
      await mockOperations(page, {
        command: async (route) =>
          await route.fulfill({ status, contentType: 'application/problem+json', body: '{}' }),
      });
      await page.goto('/operations');
      await page.getByRole('button', { name: 'Inventory', exact: true }).click();
      await page.getByLabel('Operator reason').fill('Auth failure');
      await page.getByLabel('On-hand delta').fill('1');
      await page.getByLabel('Damaged delta').fill('0');
      await page.getByRole('button', { name: 'Apply adjustment' }).click();
      await expect(page.getByText(text, { exact: false })).toBeVisible();
    });
  for (const role of ['FULFILLER', 'CUSTOMER'] as const)
    test(`${role} cannot see inventory controls`, async ({ page }) => {
      await mockOperations(page);
      await page.route(
        '**/api/v1/staff/operations/fulfillment?*',
        async (route) =>
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ items: [], nextCursor: null }),
          }),
      );
      await page.unroute('**/api/v1/auth/sessions/current');
      await page.route(
        '**/api/v1/auth/sessions/current',
        async (route) =>
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ ...auth, user: { ...auth.user, roles: [role] } }),
          }),
      );
      await page.goto('/operations');
      await expect(page.getByRole('heading', { name: 'Control room.' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Fulfillment', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Inventory', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Transfers', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Low stock', exact: true })).toHaveCount(0);
    });
  test('refuses retry when the authenticated owner changes', async ({ page }) => {
    let sessionCalls = 0;
    let commandCalls = 0;
    await mockOperations(page, {
      command: async (route) => {
        commandCalls += 1;
        await route.abort();
      },
    });
    await page.unroute('**/api/v1/auth/sessions/current');
    await page.route('**/api/v1/auth/sessions/current', async (route) => {
      sessionCalls += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...auth,
          user: { ...auth.user, id: sessionCalls > 1 ? 'admin-2' : 'admin-1' },
          csrfToken: sessionCalls > 1 ? 'csrf-2' : 'csrf-1',
        }),
      });
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await page.getByLabel('Operator reason').fill('Owner guard');
    await page.getByLabel('On-hand delta').fill('1');
    await page.getByLabel('Damaged delta').fill('0');
    await page.getByRole('button', { name: 'Apply adjustment' }).click();
    await expect(page.getByRole('button', { name: 'Retry exact inventory command' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry exact inventory command' }).click();
    await expect(page.getByText('original operator')).toBeVisible();
    await expect.poll(() => sessionCalls).toBeGreaterThan(1);
    await expect(page.getByRole('button', { name: 'Retry exact inventory command' })).toBeVisible();
    expect(commandCalls).toBe(1);
  });
  test('retains retryable 503, in-progress, and 429 outcomes', async ({ page }) => {
    const statuses = [503, 409, 429];
    let call = 0;
    await mockOperations(page, {
      command: async (route) => {
        const status = statuses[call++];
        if (status === 409)
          await route.fulfill({
            status,
            contentType: 'application/problem+json',
            body: JSON.stringify({ code: 'INVENTORY_COMMAND_IN_PROGRESS' }),
          });
        else if (status)
          await route.fulfill({ status, contentType: 'application/problem+json', body: '{}' });
        else await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      },
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await page.getByLabel('Operator reason').fill('Retryable command');
    await page.getByLabel('On-hand delta').fill('1');
    await page.getByLabel('Damaged delta').fill('0');
    await page.getByRole('button', { name: 'Apply adjustment' }).click();
    for (let index = 0; index < statuses.length; index += 1) {
      await expect(
        page.getByRole('button', { name: 'Retry exact inventory command' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Retry exact inventory command' }).click();
    }
    expect(call).toBe(3);
  });
  test('rejects blank and out-of-bounds numeric input without POST', async ({ page }) => {
    let calls = 0;
    await mockOperations(page, {
      command: async (route) => {
        calls += 1;
        await route.fulfill({ status: 200, body: '{}' });
      },
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await page.getByLabel('Operator reason').fill('Cycle count');
    await page.getByRole('button', { name: 'Apply adjustment' }).click();
    await expect(page.getByText('blank values are invalid')).toBeVisible();
    await page.getByLabel('On-hand delta').fill('1000001');
    await page.getByLabel('Damaged delta').fill('0');
    await page.getByRole('button', { name: 'Apply adjustment' }).click();
    expect(calls).toBe(0);
  });
  test('submits a bounded threshold command with its operator reason', async ({ page }) => {
    let payload = '';
    await mockOperations(page, {
      command: async (route) => {
        payload = route.request().postData() ?? '';
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ id: balance.id, version: 4, etag: '"inventory-4"' }),
        });
      },
    });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await page.getByLabel('Operator reason').fill('Threshold review');
    await page.getByLabel('Low-stock threshold').fill('3');
    await page.getByRole('button', { name: 'Set threshold' }).click();
    await expect.poll(() => payload).toContain('lowStockThreshold');
    expect(payload).toContain('Threshold review');
  });
  test('shows nested transfer labels and independent same-SKU receipt controls', async ({
    page,
  }) => {
    const second = {
      ...transfer(),
      id: '66666666-6666-4666-8666-666666666666',
      lines: [{ ...transfer().lines[0], variantId: variantA }],
    };
    await mockOperations(page, { transferRows: [transfer(), second] });
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Transfers', exact: true }).click();
    const details = page.locator('details.operations-row');
    await expect(details.filter({ hasText: 'US-EAST-01' })).toHaveCount(2);
    await details.nth(0).locator('summary').click();
    await details.nth(1).locator('summary').click();
    const receiptInputs = details.nth(0).locator('input[type="number"]');
    await receiptInputs.nth(0).fill('1');
    await expect(details.nth(1).locator('input[type="number"]').nth(0)).toHaveValue('');
    await expect(page.locator('legend').filter({ hasText: 'TEE-BLUE-M' })).toHaveCount(2);
  });
  test('keeps reconciliation and low-stock views read-only at narrow width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await mockOperations(page);
    await page.goto('/operations');
    await page.getByRole('button', { name: 'Low stock' }).click();
    await expect(page.getByText('threshold')).toBeVisible();
    await page.getByRole('button', { name: 'Inventory reconciliation' }).click();
    await expect(page.getByText('Page-scoped inventory reconciliation')).toBeVisible();
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth),
    ).toBe(true);
  });
});
