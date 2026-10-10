import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against a running demo (`npm run demo`, or set E2E_BASE_URL).
 * - "chrome": desktop/Android flows, using the locally installed Chrome.
 * - "iphone": the same flows in WebKit (Safari's engine) at iPhone size
 *   (one-time setup: `npx playwright install webkit`).
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '.data/e2e-results',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chrome', testIgnore: /iphone\.spec\.ts/, use: { channel: 'chrome' } },
    { name: 'iphone', testMatch: /iphone\.spec\.ts/, use: { ...devices['iPhone 14'], baseURL } },
  ],
});
