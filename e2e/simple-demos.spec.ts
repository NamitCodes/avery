import { devices, expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The three presenter demos, exactly as presented: one browser context is the
 * laptop on the projector, another is the phone (mobile viewport, separate login).
 * Requires a running demo (`npm run demo`).
 */

async function phone(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], baseURL: test.info().project.use.baseURL });
  return ctx.newPage();
}

/** The URL printed under a big on-screen QR (what the phone camera would open). */
const qrUrl = async (laptop: Page, caption: RegExp) =>
  (await laptop.locator('.big-qr', { hasText: caption }).locator('.mono').innerText()).trim();

test('demo index lists the three demos', async ({ page }) => {
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Demos', exact: true })).toBeVisible();
  for (const name of ['Weekly check-in', 'Planned visits', 'Surprise visits']) {
    await expect(page.getByRole('heading', { name })).toBeVisible();
  }
});

test('volunteer demo: create session, phone scans venue QR, laptop sees check-in', async ({ page: laptop, browser }) => {
  await laptop.goto('/demo/weekly');
  const title = `E2E shift ${Date.now()}`;
  await laptop.getByLabel('Session title').fill(title);
  await laptop.getByRole('button', { name: /Create (& open|another) session/ }).click();
  await expect(laptop.getByText(`Open now at`)).toContainText(title);

  const venueUrl = await qrUrl(laptop, /Science of the Soul – Amber — scan to check in/);
  const mobile = await phone(browser);
  await mobile.goto(venueUrl);
  await expect(mobile).toHaveURL(/\/login\?next=/);
  await mobile.getByRole('button', { name: /Priya Raman/ }).click();
  await expect(mobile.getByText(title)).toBeVisible(); // only session → preselected
  await mobile.getByRole('button', { name: 'Confirm attendance' }).click();
  await expect(mobile.getByRole('heading', { name: 'You’re checked in' })).toBeVisible();

  await expect(laptop.locator('tr.demo-new')).toContainText('Priya Raman', { timeout: 10_000 });
  await expect(laptop.locator('.stat .value').first()).toHaveText('1');
  await mobile.context().close();
});

test('summit demo: phone becomes gate scanner, scans a new pass for entry, duplicate, exit', async ({ page: laptop, browser }) => {
  await laptop.goto('/demo/planned');
  const signInUrl = await qrUrl(laptop, /gate staff/);
  const mobile = await phone(browser);
  await mobile.goto(signInUrl);
  await expect(mobile.getByRole('heading', { name: 'Dana Desk' })).toBeVisible();

  await laptop.getByPlaceholder('Name (optional)').fill('Ama Mensah');
  await laptop.getByRole('button', { name: /Create (participant & pass|another participant)/ }).click();
  const passUrl = await laptop.locator('.pass').getAttribute('data-pass-url');
  expect(passUrl).toMatch(/\/pass\/EVP1\./);

  await mobile.goto(passUrl!);
  await mobile.getByRole('button', { name: /Participant entry/ }).click();
  await expect(mobile.locator('.gate-result')).toContainText('ENTRY OK');
  await expect(mobile.locator('.gate-result')).toContainText('Ama Mensah');
  await mobile.getByRole('button', { name: /Participant entry/ }).click();
  await expect(mobile.locator('.gate-result')).toContainText('STOP');
  await expect(laptop.locator('.stat', { hasText: 'Ama Mensah' })).toContainText('Inside', { timeout: 10_000 });

  await mobile.getByRole('button', { name: /Participant exit/ }).click();
  await expect(mobile.locator('.gate-result')).toContainText('EXIT OK');
  await expect(laptop.locator('.stat', { hasText: 'Ama Mensah' })).toContainText('Left the venue', { timeout: 10_000 });
  await mobile.context().close();
});

test('open-event demo: phone registers without account, laptop checks in; walk-in without phone', async ({ page: laptop, browser }) => {
  await laptop.goto('/demo/surprise');
  const registerUrl = await qrUrl(laptop, /register/);
  const mobile = await phone(browser);
  await mobile.goto(registerUrl);
  const visitor = `Phone Visitor ${Date.now() % 100000}`;
  await mobile.getByLabel(/Full name/).fill(visitor);
  await mobile.getByLabel(/Phone/).fill(`+65 9${String(Date.now()).slice(-7)}`);
  await mobile.getByRole('button', { name: 'Register' }).click();
  await expect(mobile.getByText('You’re registered.')).toBeVisible();

  const row = laptop.locator('tr', { hasText: visitor });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole('button', { name: 'Check in' }).click();
  await expect(laptop.getByText(`${visitor} checked in.`)).toBeVisible();
  await expect(row).toContainText('Checked in');

  await laptop.getByPlaceholder(/Visitor’s name/).fill('Mdm Wong');
  await laptop.getByRole('button', { name: 'Register walk-in' }).click();
  await expect(laptop.locator('.pass')).toContainText('Mdm Wong');
  await laptop.getByRole('button', { name: /Check Mdm Wong in/ }).click();
  await expect(laptop.getByText('Mdm Wong checked in.')).toBeVisible();
  await mobile.context().close();
});
