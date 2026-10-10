import { devices, expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Planned-visits demo on an iPhone (runs in the "iphone" project: WebKit engine,
 * iPhone 14 viewport). The phone scans passes with its own camera, which opens the
 * pass page; `laptop` is a separate desktop-sized context in the same engine.
 * Requires a running demo (`npm run demo`) and `npx playwright install webkit`.
 */

async function iphone(browser: Browser, baseURL: string): Promise<Page> {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], baseURL });
  return ctx.newPage();
}

const GATES = ['Event volunteer entry', 'Event volunteer exit', 'Participant entry', 'Participant exit'];

test('iPhone: gate staff see all four gates, admit a new pass, and get STOP for the old pass', async ({ page: laptop, browser, baseURL }) => {
  await laptop.setViewportSize({ width: 1366, height: 900 });
  await laptop.goto('/demo/planned');
  await laptop.getByRole('button', { name: /Create (participant & pass|another participant)/ }).click();
  const passUrl = (await laptop.locator('.pass').getAttribute('data-pass-url'))!;
  const signInUrl = (await laptop.locator('.big-qr', { hasText: /gate staff/ }).locator('.mono').innerText()).trim();
  const oldPassUrl = (await laptop.locator('.big-qr', { hasText: /Old pass/ }).locator('.mono').innerText()).trim();

  const phone = await iphone(browser, baseURL!);
  await phone.goto(signInUrl);
  await expect(phone.getByRole('heading', { name: 'Dana Desk' })).toBeVisible();

  await phone.goto(passUrl);
  for (const name of GATES) await expect(phone.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await phone.getByRole('button', { name: /^Participant entry/ }).click();
  await expect(phone.locator('.gate-result')).toContainText('ENTRY OK');

  await phone.goto(oldPassUrl);
  await expect(phone.getByText(/This pass is not valid/)).toBeVisible();
  await expect(phone.locator('.gate-actions button')).toHaveCount(4);
  await phone.getByRole('button', { name: /^Participant entry/ }).click();
  await expect(phone.locator('.gate-result')).toContainText('STOP');
  await expect(phone.locator('.gate-result')).toContainText(/revoked or replaced/);
  await phone.context().close();
});

test('iPhone still signed in as a volunteer is told how to switch, then sees the gates', async ({ page: laptop, browser, baseURL }) => {
  await laptop.setViewportSize({ width: 1366, height: 900 });
  await laptop.goto('/demo/planned');
  await laptop.getByRole('button', { name: /Create (participant & pass|another participant)/ }).click();
  const passUrl = (await laptop.locator('.pass').getAttribute('data-pass-url'))!;

  const phone = await iphone(browser, baseURL!);
  await phone.goto('/demo/signin/priya?next=/');
  await expect(phone.getByRole('heading', { name: /Hello, Priya/ })).toBeVisible();
  await phone.goto(passUrl);
  await expect(phone.getByText(/gate buttons need a gate-staff account/)).toBeVisible();
  await phone.getByRole('button', { name: 'Demo: sign in as gate staff' }).click();
  for (const name of GATES) await expect(phone.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await phone.context().close();
});

test('iPhone signed in as the gate operator sees all four Planned-visits gates', async ({ page: laptop, browser, baseURL }) => {
  await laptop.setViewportSize({ width: 1366, height: 900 });
  await laptop.goto('/demo/planned');
  await laptop.getByRole('button', { name: /Create (participant & pass|another participant)/ }).click();
  const passUrl = (await laptop.locator('.pass').getAttribute('data-pass-url'))!;

  const phone = await iphone(browser, baseURL!);
  await phone.goto(passUrl);
  await phone.getByRole('link', { name: /Staff: sign in/ }).click();
  await phone.getByRole('button', { name: /Gabe Gate/ }).click();
  await phone.waitForURL(/\/pass\//);
  for (const name of GATES) await expect(phone.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await phone.context().close();
});
