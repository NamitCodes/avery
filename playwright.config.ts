import { defineConfig } from '@playwright/test';

/**
 * Browser tests against a running demo (`npm run demo`, or set E2E_BASE_URL).
 * Uses the locally installed Chrome, so no browser download is needed.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '.data/e2e-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
