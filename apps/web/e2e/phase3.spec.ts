import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN ?? 'http://localhost:4000';
const adminEmail = process.env.PHASE3_DEMO_ADMIN_EMAIL ?? 'admin.phase3@pulsefield.local';
const fulfillerEmail =
  process.env.PHASE3_DEMO_FULFILLER_EMAIL ?? 'fulfiller.phase3@pulsefield.local';
const adminPassword = process.env.PHASE3_DEMO_ADMIN_PASSWORD;
const fulfillerPassword = process.env.PHASE3_DEMO_FULFILLER_PASSWORD;

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
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function signInStaff(
  page: Page,
  email: string,
  password: string,
  configuredSecret: string | undefined,
): Promise<void> {
  await page.goto('/operations/sign-in');
  await expect(page.getByRole('heading', { name: 'Operations sign-in' })).toBeVisible();
  const continueButton = page.getByRole('button', { name: 'Continue' });
  // Wait for hydration before interacting with controlled fields or submitting the form.
  await expect(continueButton).toBeEnabled({ timeout: 20_000 });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/auth/sessions',
  );
  await continueButton.click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status()).toBe(202);
  const loginChallenge = (await loginResponse.json()) as { status?: string };
  expect(['MFA_REQUIRED', 'MFA_ENROLLMENT_REQUIRED']).toContain(loginChallenge.status);

  await expect(page.getByLabel('Authenticator code')).toBeVisible({ timeout: 20_000 });
  const enrollment = await page.getByRole('heading', { name: 'Set up authenticator' }).count();
  // The secret is read only into this test's memory. It is never logged or persisted.
  const secret =
    enrollment > 0
      ? ((await page.locator('code').first().textContent()) ?? '').trim()
      : configuredSecret;
  if (!secret) {
    throw new Error('Provide the ignored current TOTP secret for an already enrolled staff user.');
  }
  await page.getByLabel('Authenticator code').fill(totp(secret));
  const enrollmentResponsePromise =
    enrollment > 0
      ? page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/v1/auth/mfa-enrollments',
        )
      : null;
  const freshLoginResponsePromise =
    enrollment > 0
      ? page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/v1/auth/sessions',
        )
      : null;
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  if (enrollment > 0) {
    // Enrollment creates a fresh MFA challenge; authenticate it through the UI as well.
    const enrollmentResponse = await enrollmentResponsePromise!;
    expect(enrollmentResponse.status()).toBe(201);
    const freshLoginResponse = await freshLoginResponsePromise!;
    expect(freshLoginResponse.status()).toBe(202);
    const freshChallenge = (await freshLoginResponse.json()) as { status?: string };
    expect(freshChallenge.status).toBe('MFA_REQUIRED');
    await expect(page.getByRole('heading', { name: 'Verify authenticator' })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByLabel('Authenticator code').fill(totp(secret, Date.now() + 30_000));
    await page.getByRole('button', { name: 'Verify and continue' }).click();
  }
  await page.waitForURL('**/operations');
  await expect(page.getByRole('heading', { name: 'Control room.' })).toBeVisible();
}

async function advanceOnce(
  page: Page,
  fulfillmentRow: Locator,
  expectedStatus: string,
): Promise<void> {
  await fulfillmentRow.getByRole('button', { name: 'Advance' }).click();
  await expect(page.locator('tbody')).toContainText(expectedStatus);
}

test.describe('Phase 3 critical local journey', () => {
  test('catalog UI to checkout UI, staff MFA UI, and role-aware operations UI', async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      !adminPassword || !fulfillerPassword,
      'Set ignored Phase 3 demo passwords to run the full local journey.',
    );

    // Exercise the storefront in a real browser context, preserving its guest cart cookie.
    await page.goto('/catalog');
    await expect(page.getByRole('heading', { name: 'Move with intent.' })).toBeVisible();
    await page.getByRole('link', { name: /View /u }).first().click();
    await expect(page.locator('.product-detail h1')).toBeVisible();
    await page.getByRole('button', { name: 'Add to cart' }).first().click();
    await expect(page.getByText('Added to cart.')).toBeVisible();
    await page.getByRole('link', { name: 'Cart' }).click();
    await expect(page.getByRole('heading', { name: 'Cart.' })).toBeVisible();
    await page.getByRole('link', { name: 'Continue to checkout →' }).click();
    await expect(page.getByRole('heading', { name: 'Checkout.' })).toBeVisible();
    await page.getByLabel('Full name').fill('Demo Walkthrough');
    await page.getByLabel('Address', { exact: true }).fill('1 Test Street');
    await page.getByLabel('City').fill('Austin');
    await page.getByLabel('State').fill('TX');
    await page.getByLabel('PostalCode').fill('78701');
    await page.getByRole('button', { name: 'Preview authoritative total' }).click();
    await expect(page.getByText('Authoritative total', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Place demo order' }).click();
    await expect(page.getByRole('heading', { name: 'Order confirmed.' })).toBeVisible();
    const confirmationText = await page.locator('.state .eyebrow').textContent();
    const orderReference = confirmationText?.replace(/^Order\s+/u, '').trim();
    expect(orderReference).toMatch(/^PF-/u);

    // Each staff role receives an isolated browser context and completes MFA through the UI.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, adminEmail, adminPassword!, process.env.PHASE3_ADMIN_TOTP_SECRET);
    await expect(adminPage.getByRole('button', { name: 'Catalog' })).toBeVisible();
    await adminPage.getByRole('button', { name: 'Orders' }).click();
    await expect(adminPage.locator('table')).toBeVisible();
    const adminTable = adminPage.locator('table');
    await expect(adminTable).toContainText(orderReference!);
    await expect(adminTable).not.toContainText('Demo Walkthrough');
    await expect(adminTable).not.toContainText('Test Street');
    await expect(adminTable).not.toContainText('78701');
    await adminPage.getByRole('button', { name: 'Fulfillment' }).click();
    await expect(adminPage.locator('table')).toBeVisible();
    // Administrator is read-only for fulfillment transitions, even when viewing the queue.
    await expect(adminPage.getByRole('button', { name: 'Advance' })).toHaveCount(0);

    const fulfillerContext = await browser.newContext();
    const fulfillerPage = await fulfillerContext.newPage();
    await signInStaff(
      fulfillerPage,
      fulfillerEmail,
      fulfillerPassword!,
      process.env.PHASE3_FULFILLER_TOTP_SECRET,
    );
    await expect(fulfillerPage.getByRole('heading', { name: 'Fulfillment' })).toBeVisible();
    await expect(fulfillerPage.getByRole('button', { name: 'Catalog' })).toHaveCount(0);
    const fulfillmentRow = fulfillerPage.locator('tbody tr').filter({ hasText: orderReference! });
    await expect(fulfillmentRow.getByRole('button', { name: 'Advance' })).toBeVisible();
    await advanceOnce(fulfillerPage, fulfillmentRow, 'PICKING');
    await advanceOnce(fulfillerPage, fulfillmentRow, 'PACKED');
    await advanceOnce(fulfillerPage, fulfillmentRow, 'SHIPPED');
    await advanceOnce(fulfillerPage, fulfillmentRow, 'DELIVERED');

    await fulfillerContext.close();
    await adminContext.close();
  });

  test('keeps operations and sign-in surfaces safe without staff credentials', async ({
    page,
    request,
  }) => {
    await page.goto('/operations/sign-in');
    await expect(page.getByRole('heading', { name: 'Operations sign-in' })).toBeVisible();
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });
    const response = await request.get(`${apiOrigin}/api/v1/staff/operations/catalog`);
    expect([401, 403]).toContain(response.status());
  });
});
