import { createHmac } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    phase5HoldRealtime: boolean;
    phase5Sockets: WebSocket[];
  }
}

const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN ?? 'http://localhost:4000';
const acceptanceDatabase = process.env.PHASE5_ACCEPTANCE_DATABASE_NAME;

async function saveAcceptanceVisual(page: Page, name: string): Promise<void> {
  if (process.env.PHASE5_ACCEPTANCE_VISUALS !== 'true') return;
  // Capture only verified commerce/operations views, never MFA enrollment or
  // the browser address bar (which can contain a guest access credential).
  await page.screenshot({
    path: path.resolve('.local/acceptance/visuals', `${name}.png`),
    fullPage: name === 'customer-split-order',
  });
}
const sku = process.env.PHASE5_ACCEPTANCE_SKU ?? 'PF-AERO-BLU-L';
const adminEmail = process.env.PHASE3_DEMO_ADMIN_EMAIL ?? 'admin.phase3@pulsefield.local';
const fulfillerEmail =
  process.env.PHASE3_DEMO_FULFILLER_EMAIL ?? 'fulfiller.phase3@pulsefield.local';
const adminPassword = process.env.PHASE3_DEMO_ADMIN_PASSWORD;
const fulfillerPassword = process.env.PHASE3_DEMO_FULFILLER_PASSWORD;
const staffSecrets = new Map<string, string>();
const staffSteps = new Map<string, number>();

type Balance = {
  id: string;
  warehouseId: string;
  warehouseCode?: string;
  variantId: string;
  sku?: string;
  onHand: number;
  available: number;
  lowStockThreshold: number;
  version: number;
};

function base32Decode(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.toUpperCase().replace(/=+$/u, '')) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('invalid secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret: string, timestamp = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function nextStaffCode(email: string, secret: string): Promise<string> {
  const step = Math.max(Math.floor(Date.now() / 30_000), (staffSteps.get(email) ?? -1) + 1);
  // Wait for the server's normal +/- one-step window; never bypass replay protection.
  while (step > Math.floor(Date.now() / 30_000) + 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  staffSteps.set(email, step);
  return totp(secret, step * 30_000);
}

async function signInStaff(
  page: Page,
  email: string,
  password: string,
  configuredSecret: string | undefined,
): Promise<void> {
  await page.goto('/operations/sign-in');
  await expect(page.getByRole('heading', { name: 'Operations sign-in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 20_000 });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const login = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/auth/sessions',
  );
  await page.getByRole('button', { name: 'Continue' }).click();
  expect((await login).status()).toBe(202);
  await expect(page.getByLabel('Authenticator code')).toBeVisible({ timeout: 20_000 });
  const enrollment = await page.getByRole('heading', { name: 'Set up authenticator' }).count();
  const secret =
    enrollment > 0
      ? ((await page.locator('code').first().textContent()) ?? '').trim()
      : (configuredSecret ?? staffSecrets.get(email));
  if (!secret) throw new Error('A current Phase 5 staff TOTP secret is required.');
  staffSecrets.set(email, secret);
  await page.getByLabel('Authenticator code').fill(await nextStaffCode(email, secret));
  const enrollmentResponse = enrollment
    ? page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/auth/mfa-enrollments',
      )
    : null;
  const secondLogin = enrollment
    ? page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/auth/sessions',
      )
    : null;
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  if (enrollment) {
    expect((await enrollmentResponse!).status()).toBe(201);
    expect((await secondLogin!).status()).toBe(202);
    await expect(page.getByRole('heading', { name: 'Verify authenticator' })).toBeVisible();
    await page.getByLabel('Authenticator code').fill(await nextStaffCode(email, secret));
    await page.getByRole('button', { name: 'Verify and continue' }).click();
  }
  await page.waitForURL('**/operations');
  await expect(page.getByRole('heading', { name: 'Control room.' })).toBeVisible();
}

async function balances(page: Page, requestedSku = sku): Promise<Balance[]> {
  const response = await page.request.get(
    `${apiOrigin}/api/v1/staff/operations/inventory?pageSize=100&sku=${encodeURIComponent(requestedSku)}`,
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { items: Balance[] }).items;
}

async function showInventoryRow(
  page: Page,
  warehouseCode: string,
  requestedSku = sku,
): Promise<void> {
  await expect(page.getByText('Inventory adjustment and threshold controls')).toBeVisible();
  const row = page
    .locator('.operations-row')
    .filter({ hasText: `${warehouseCode} · ${requestedSku}` });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    const next = page.getByRole('button', { name: 'Next page' });
    if (!(await next.isEnabled().catch(() => false))) break;
    await next.click();
    await expect(page.getByText('Inventory adjustment and threshold controls')).toBeVisible();
  }
  throw new Error(`Inventory row ${warehouseCode} / ${requestedSku} was not rendered.`);
}

function balanceFor(rows: Balance[], warehouseCode: string, requestedSku = sku): Balance {
  const row = rows.find(
    (item) => (item.sku ?? '') === requestedSku && (item.warehouseCode ?? '') === warehouseCode,
  );
  if (!row) throw new Error(`Missing ${sku} balance in ${warehouseCode}.`);
  return row;
}

async function adjustTo(page: Page, warehouseCode: string, target: number): Promise<void> {
  const row = balanceFor(await balances(page), warehouseCode);
  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await showInventoryRow(page, warehouseCode);
  const rowView = page.locator('.operations-row').filter({ hasText: `${warehouseCode} · ${sku}` });
  await expect(rowView).toBeVisible();
  await page.getByLabel('Operator reason').fill(`Phase 5 acceptance stock ${target}`);
  await page.getByLabel('On-hand delta').fill(String(target - row.onHand));
  await page.getByLabel('Damaged delta').fill('0');
  await rowView.getByRole('button', { name: 'Apply adjustment' }).click();
  await expect(page.getByText('Inventory command completed.').first()).toBeVisible();
}

async function advance(
  page: Page,
  rowText: string,
  status: string,
  orderReference: string,
): Promise<void> {
  const row = page
    .locator('tbody tr')
    .filter({ hasText: orderReference })
    .filter({ hasText: rowText });
  const columns = await page.locator('thead th').allTextContents();
  const statusColumn = columns.indexOf('status');
  expect(statusColumn).toBeGreaterThanOrEqual(0);
  const transition = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.includes('/staff/fulfillment-groups/'),
  );
  await row.getByRole('button', { name: 'Advance' }).click();
  expect((await transition).status()).toBe(200);
  await expect(row.locator('td').nth(statusColumn)).toHaveText(status);
}

async function checkoutSplit(page: Page): Promise<string> {
  const catalog = await page.request.get(`${apiOrigin}/api/v1/catalog/products?pageSize=24`);
  expect(catalog.ok()).toBe(true);
  const products = (await catalog.json()) as {
    items: Array<{
      slug: string;
      variants: Array<{ id: string; sku: string; inStock: boolean }>;
    }>;
  };
  const product = products.items.find((item) =>
    item.variants.some((variant) => variant.sku === sku),
  );
  if (!product) throw new Error(`Catalog product for ${sku} was not found.`);
  const variant = product.variants.find((item) => item.sku === sku);
  if (!variant) throw new Error(`Catalog variant for ${sku} was not found.`);
  await page.goto(`/catalog/${product.slug}`);
  await expect(page.getByRole('button', { name: /Add to cart/u })).toBeVisible();
  await page.locator(`input[type="radio"][value="${variant.id}"]`).check();
  await page.getByLabel('Quantity').fill('2');
  await page.getByRole('button', { name: /Add to cart/u }).click();
  await expect(page.getByText('Added to cart.')).toBeVisible();
  await page.getByRole('link', { name: 'Cart' }).first().click();
  await page.getByRole('link', { name: 'Continue to checkout →' }).first().click();
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  await page.getByLabel('Email for order confirmation').fill('phase5.acceptance@example.test');
  await page.getByLabel('Full name').fill('Phase Five Acceptance');
  await page.getByLabel('Address', { exact: true }).fill('1 Test Street');
  await page.getByLabel('City').fill('Austin');
  await page.getByLabel('State').fill('TX');
  await page.getByLabel('PostalCode').fill('78701');
  await page.getByRole('button', { name: 'Preview authoritative total' }).click();
  await expect(page.getByText('Authoritative total', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Place demo order' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed.' })).toBeVisible();
  const reference = (await page.locator('.state .eyebrow').textContent())
    ?.replace(/^Order\s+/u, '')
    .trim();
  expect(reference).toMatch(/^PF-/u);
  return reference!;
}

test.describe('Phase 5 live local acceptance', () => {
  test.use({ actionTimeout: 10_000 });
  test.skip(
    !acceptanceDatabase,
    'Run through pnpm test:phase5:browser against its owned database.',
  );
  test.beforeAll(() => {
    if (acceptanceDatabase && !/_test$/u.test(acceptanceDatabase))
      throw new Error('PHASE5_ACCEPTANCE_DATABASE_NAME must end in _test.');
    const missing = [
      ['PHASE5_ACCEPTANCE_DATABASE_NAME', acceptanceDatabase],
      ['PHASE3_DEMO_ADMIN_PASSWORD', adminPassword],
      ['PHASE3_DEMO_FULFILLER_PASSWORD', fulfillerPassword],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) throw new Error(`Phase 5 live acceptance requires: ${missing.join(', ')}`);
  });

  test('performs real transfer and split checkout with independent fulfillment groups', async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000);
    const admin = await browser.newContext();
    // The commerce journey also proves REST remains usable without realtime.
    await admin.routeWebSocket('**/api/v1/realtime/socket.io/**', (socket) => socket.close());
    const adminPage = await admin.newPage();
    adminPage.setDefaultTimeout(10_000);
    adminPage.setDefaultNavigationTimeout(20_000);
    await signInStaff(adminPage, adminEmail, adminPassword!, process.env.PHASE3_ADMIN_TOTP_SECRET);
    const initial = await balances(adminPage);
    const source = balanceFor(initial, 'US-EAST-01');
    const destination = balanceFor(initial, 'MA-CASA-01');

    await adminPage.getByRole('button', { name: 'Transfers', exact: true }).click();
    await adminPage.getByLabel('Source warehouse ID').fill(source.warehouseId);
    await adminPage.getByLabel('Destination warehouse ID').fill(destination.warehouseId);
    await adminPage.getByLabel('Variant UUID').fill(source.variantId);
    await adminPage.getByLabel('Quantity').fill('1');
    await adminPage.getByRole('button', { name: 'Add line' }).click();
    await adminPage.getByLabel('Operator reason').fill('Phase 5 live transfer');
    const transferResponse = adminPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/staff/inventory/transfers',
    );
    await adminPage.getByRole('button', { name: 'Request transfer' }).click();
    expect((await transferResponse).status()).toBe(201);
    const transferPage = await adminPage.request.get(
      `${apiOrigin}/api/v1/staff/operations/inventory-transfers?pageSize=100`,
    );
    expect(transferPage.status()).toBe(200);
    const transferPayload = (
      (await transferPage.json()) as { items: Array<{ id: string; reason: string }> }
    ).items.find((item) => item.reason === 'Phase 5 live transfer');
    expect(transferPayload).toBeDefined();
    const transfer = adminPage
      .locator('details.operations-row')
      .filter({ hasText: transferPayload!.id });
    await expect(transfer).toBeVisible();
    await transfer.locator('summary').click();
    await adminPage.getByLabel('Operator reason').fill('Phase 5 live dispatch');
    await transfer.getByRole('button', { name: 'Dispatch' }).click();
    await expect(transfer).toContainText('IN_TRANSIT');
    await transfer.locator('summary').click();
    await adminPage.getByLabel('Operator reason').fill('Phase 5 live receipt');
    await transfer.getByLabel('received').fill('0');
    await transfer.getByLabel('damaged').fill('0');
    await transfer.getByLabel('lost').fill('1');
    await transfer.getByRole('button', { name: 'Complete receipt' }).click();
    await expect(transfer).toContainText('RECEIVED');

    await adjustTo(adminPage, 'US-EAST-01', 1);
    await adjustTo(adminPage, 'EU-CENTRAL-01', 1);
    await adjustTo(adminPage, 'MA-CASA-01', 0);

    const orderReference = await checkoutSplit(page);
    const fulfiller = await browser.newContext();
    await fulfiller.routeWebSocket('**/api/v1/realtime/socket.io/**', (socket) => socket.close());
    const fulfillerPage = await fulfiller.newPage();
    fulfillerPage.setDefaultTimeout(10_000);
    fulfillerPage.setDefaultNavigationTimeout(20_000);
    await signInStaff(
      fulfillerPage,
      fulfillerEmail,
      fulfillerPassword!,
      process.env.PHASE3_FULFILLER_TOTP_SECRET,
    );
    await expect(fulfillerPage.locator('tbody tr').filter({ hasText: orderReference })).toHaveCount(
      2,
    );
    const groups = fulfillerPage.locator('tbody tr').filter({ hasText: orderReference });
    const firstWarehouse =
      (await groups.nth(0).textContent())?.match(/US-EAST-01|EU-CENTRAL-01|MA-CASA-01/u)?.[0] ?? '';
    const secondWarehouse =
      (await groups.nth(1).textContent())?.match(/US-EAST-01|EU-CENTRAL-01|MA-CASA-01/u)?.[0] ?? '';
    expect(firstWarehouse).not.toBe('');
    expect(secondWarehouse).not.toBe('');
    expect(firstWarehouse).not.toBe(secondWarehouse);
    await advance(fulfillerPage, firstWarehouse, 'PICKING', orderReference);
    await advance(fulfillerPage, firstWarehouse, 'PACKED', orderReference);
    await advance(fulfillerPage, firstWarehouse, 'SHIPPED', orderReference);
    await expect(groups.filter({ hasText: secondWarehouse })).toContainText('ALLOCATED');
    await saveAcceptanceVisual(fulfillerPage, 'split-fulfillment');
    try {
      await page.getByRole('link', { name: 'View order timeline →' }).click();
    } catch {
      // Do not retain navigation diagnostics containing the guest URL fragment.
      throw new Error('Guest order timeline navigation failed.');
    }
    await expect(page.getByRole('heading', { name: 'Your order', exact: true })).toBeVisible();
    await expect(page.locator('header .detail-note')).toContainText('PARTIALLY SHIPPED');
    await expect(page.locator('.order-line').filter({ hasText: 'Shipment' })).toHaveCount(2);
    await expect(page.locator('main')).not.toContainText(/US-EAST-01|EU-CENTRAL-01|MA-CASA-01/u);
    await saveAcceptanceVisual(page, 'customer-split-order');
    await advance(fulfillerPage, secondWarehouse, 'PICKING', orderReference);
    await advance(fulfillerPage, secondWarehouse, 'PACKED', orderReference);
    await advance(fulfillerPage, secondWarehouse, 'SHIPPED', orderReference);
    await advance(fulfillerPage, secondWarehouse, 'DELIVERED', orderReference);
    await advance(fulfillerPage, firstWarehouse, 'DELIVERED', orderReference);
    try {
      await page.reload();
    } catch {
      throw new Error('Guest order timeline refresh failed.');
    }
    await expect(page.locator('header .detail-note')).toContainText('DELIVERED');
    await expect(page.locator('.order-line').filter({ hasText: 'Shipment' })).toHaveCount(2);

    await adminPage.goto('/operations');
    await expect(adminPage.getByRole('heading', { name: 'Control room.' })).toBeVisible();
    await adminPage.getByRole('button', { name: 'Inventory reconciliation' }).click();
    await expect(adminPage.getByText(/Page-scoped inventory reconciliation/u)).toBeVisible();
    const reconciliation = await adminPage.request.get(
      `${apiOrigin}/api/v1/staff/operations/inventory-reconciliation?pageSize=100&sku=${encodeURIComponent(sku)}`,
    );
    expect(reconciliation.ok()).toBe(true);
    const reconciliationPayload = (await reconciliation.json()) as {
      items: Array<{ mismatchCategories: unknown[] }>;
      mismatchCount: number;
      clean: boolean;
    };
    expect(reconciliationPayload.items).toHaveLength(3);
    expect(reconciliationPayload.items.every((item) => item.mismatchCategories.length === 0)).toBe(
      true,
    );
    expect(reconciliationPayload).toMatchObject({ mismatchCount: 0, clean: true });
    await expect(adminPage.getByRole('table')).toBeVisible();
    await saveAcceptanceVisual(adminPage, 'inventory-reconciliation');

    await expect(fulfillerPage.getByRole('button', { name: 'Catalog' })).toHaveCount(0);
    await expect(fulfillerPage.getByRole('button', { name: 'Inventory', exact: true })).toHaveCount(
      0,
    );
    const deniedInventory = await fulfillerPage.request.get(
      `${apiOrigin}/api/v1/staff/operations/inventory`,
    );
    expect(deniedInventory.status()).toBe(403);
    await adminPage.getByRole('button', { name: 'Fulfillment', exact: true }).click();
    await expect(adminPage.locator('tbody tr').filter({ hasText: orderReference })).toHaveCount(2);
    await expect(adminPage.getByRole('button', { name: 'Advance' })).toHaveCount(0);
    await fulfiller.close();
    await admin.close();
  });

  test('refreshes from real Socket.IO invalidation after transport interruption', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    let resyncs = 0;
    let invalidations = 0;
    const admin = await browser.newContext();
    // Keep native WebSockets and real server frames. Only inject transport faults.
    await admin.addInitScript(() => {
      const control = window as Window & {
        phase5HoldRealtime: boolean;
        phase5Sockets: WebSocket[];
      };
      control.phase5HoldRealtime = sessionStorage.getItem('phase5-transport-fault') === 'hold';
      control.phase5Sockets = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes('/api/v1/realtime/socket.io/')) {
            control.phase5Sockets.push(this);
            if (control.phase5HoldRealtime) this.close();
          }
        }
      };
    });
    const page = await admin.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/api/v1/realtime/socket.io/')) return;
      socket.on('framereceived', ({ payload }) => {
        const frame = String(payload);
        if (frame.includes('"resync"')) resyncs += 1;
        if (frame.includes('"invalidate"')) invalidations += 1;
      });
    });
    await signInStaff(page, adminEmail, adminPassword!, process.env.PHASE3_ADMIN_TOTP_SECRET);
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await expect(page.getByText('Inventory adjustment and threshold controls')).toBeVisible();
    const visibleIdentity = (await page.locator('.operations-row').first().textContent()) ?? '';
    const [watchWarehouse, watchSku] = visibleIdentity.split(' · ');
    expect(watchWarehouse).toMatch(/^[A-Z0-9-]+$/u);
    expect(watchSku).toBeTruthy();
    await expect.poll(() => resyncs, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.evaluate(() => {
      const control = window as Window & {
        phase5HoldRealtime: boolean;
        phase5Sockets: WebSocket[];
      };
      control.phase5HoldRealtime = true;
      sessionStorage.setItem('phase5-transport-fault', 'hold');
      for (const socket of control.phase5Sockets) {
        if (socket.readyState <= WebSocket.OPEN)
          socket.close(4001, 'acceptance transport interruption');
      }
    });

    const mutatorContext = await browser.newContext({ storageState: await admin.storageState() });
    await mutatorContext.routeWebSocket('**/api/v1/realtime/socket.io/**', (socket) =>
      socket.close(),
    );
    const mutator = await mutatorContext.newPage();
    mutator.setDefaultTimeout(10_000);
    await mutator.goto('/operations');
    await expect(mutator.getByRole('heading', { name: 'Control room.' })).toBeVisible();
    const row = balanceFor(await balances(mutator, watchSku), watchWarehouse, watchSku);
    await mutator.getByRole('button', { name: 'Inventory', exact: true }).click();
    await showInventoryRow(mutator, watchWarehouse, watchSku);
    const target = mutator
      .locator('.operations-row')
      .filter({ hasText: `${watchWarehouse} · ${watchSku}` });
    await expect(target.getByRole('button', { name: 'Set threshold' })).toBeVisible();
    async function setThreshold(value: number, reason: string) {
      await mutator.getByLabel('Operator reason').fill(reason);
      await mutator.getByLabel('Low-stock threshold').fill(String(value));
      const committed = mutator.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/balances/${row.id}/thresholds`),
      );
      await target.getByRole('button', { name: 'Set threshold' }).click();
      expect((await committed).status()).toBe(200);
      await expect(target).toContainText(`threshold ${value}`);
    }
    await setThreshold(row.lowStockThreshold + 1, 'Phase 5 realtime refresh');
    await expect(
      page.locator('.operations-row').filter({ hasText: `${watchWarehouse} · ${watchSku}` }),
    ).toContainText(`threshold ${row.lowStockThreshold}`);
    await page.reload();
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await showInventoryRow(page, watchWarehouse, watchSku);
    await expect(
      page.locator('.operations-row').filter({ hasText: `${watchWarehouse} · ${watchSku}` }),
    ).toContainText(`threshold ${row.lowStockThreshold + 1}`);
    const resyncsBeforeReconnect = resyncs;
    await setThreshold(row.lowStockThreshold + 2, 'Phase 5 realtime missed update');
    await expect(
      page.locator('.operations-row').filter({ hasText: `${watchWarehouse} · ${watchSku}` }),
    ).toContainText(`threshold ${row.lowStockThreshold + 1}`);
    await page.evaluate(() => {
      (window as Window & { phase5HoldRealtime: boolean }).phase5HoldRealtime = false;
      sessionStorage.removeItem('phase5-transport-fault');
    });
    await expect.poll(() => resyncs, { timeout: 30_000 }).toBeGreaterThan(resyncsBeforeReconnect);
    await expect(
      page.locator('.operations-row').filter({ hasText: `${watchWarehouse} · ${watchSku}` }),
    ).toContainText(`threshold ${row.lowStockThreshold + 2}`);
    const invalidationsBeforeUpdate = invalidations;
    await setThreshold(row.lowStockThreshold + 3, 'Phase 5 realtime invalidation');
    await expect
      .poll(() => invalidations, { timeout: 15_000 })
      .toBeGreaterThan(invalidationsBeforeUpdate);
    await expect(
      page.locator('.operations-row').filter({ hasText: `${watchWarehouse} · ${watchSku}` }),
    ).toContainText(`threshold ${row.lowStockThreshold + 3}`, { timeout: 15_000 });
    await page.close();
    await mutator.close();
    await mutatorContext.close();
    await admin.close();
  });

  test('keeps unauthenticated operations and least-privileged views denied', async ({ page }) => {
    await page.goto('/operations');
    await expect(page.getByRole('heading', { name: 'Staff access required' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    const response = await page.request.get(`${apiOrigin}/api/v1/staff/operations/inventory`);
    expect([401, 403]).toContain(response.status());
  });
});
