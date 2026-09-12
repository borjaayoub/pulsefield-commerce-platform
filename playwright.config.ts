import { defineConfig, devices } from '@playwright/test';
import { config as loadEnvironment } from 'dotenv';
import path from 'node:path';

loadEnvironment({ path: path.resolve(process.cwd(), '.env'), override: false });

export default defineConfig({
  testDir: './apps/web/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_WEB_ORIGIN ?? 'http://localhost:3000',
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? 'chrome',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    ...devices['Desktop Chrome'],
  },
});
