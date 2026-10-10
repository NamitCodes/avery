import { expect, test, type Page } from '@playwright/test';

/**
 * Browser walk-through of the demo guide against a running demo
 * (`npm run demo`). Tests change demo data but are written to pass on re-runs;
 * `npm run demo` resets everything.
 */

interface Demo {
  seeded: boolean;
  password: string;
  accounts: { key: string; email: string }[];
  venues: { key: string; path: string }[];
  gates: { key: string; id: string }[];
  passes: { key: string; pass_url: string; pass_path: string }[];
  events: { key: string; id: string }[];
}

let demo: Demo;

test.beforeAll(async ({ request }) => {
  const res = await request.get('/api/demo');
  expect(res.ok(), 'demo mode must be on (run `npm run demo`)').toBeTruthy();
  demo = await res.json();
  expect(demo.seeded).toBe(true);
});

async function signIn(page: Page, key: string) {
  const email = demo.accounts.find((a) => a.key === key)!.email;
  const res = await page.request.post('/api/auth/login', {
    data: { email, password: demo.password },
    headers: { 'X-Requested-With': 'fetch' },
  });
  expect(res.ok()).toBeTruthy();
}

/** Collect real errors (ignoring the expected 401 from the anonymous "who am I" check). */
function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

const gate = (k: string) => demo.gates.find((g) => g.key === k)!.id;
const pass = (k: string) => demo.passes.find((p) => p.key === k)!;

test('home page and demo guide render without errors', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Volunteer attendance' })).toBeVisible();
  await page.goto('/demo/full');
  await expect(page.getByRole('heading', { name: 'Full demo guide' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /A · Weekly check-in/ })).toBeVisible();
  await expect(page.locator('#passes img')).toHaveCount(demo.passes.length);
  expect(errors).toEqual([]);
});

test('guide button signs in as a volunteer and checks in at an overlapping-session venue', async ({ page }) => {
  await page.goto('/demo/full');
  await page.getByRole('button', { name: /Scan Tagore as Priya/ }).click();
  await expect(page).toHaveURL(/\/check-in\/v\//);
  await expect(page.getByRole('heading', { name: 'Science of the Soul – Tagore' })).toBeVisible();
  await page.getByRole('button', { name: /Wednesday Seva/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Confirm attendance' }).click();
  await expect(page.getByRole('heading', { name: 'You’re checked in' })).toBeVisible();
  await expect(page.getByText('Tap-in time', { exact: true })).toBeVisible();

  // Scanning again returns the original record.
  await page.goto(demo.venues.find((v) => v.key === 'tagore')!.path);
  await page.getByRole('button', { name: /Wednesday Seva/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Confirm attendance' }).click();
  await expect(page.getByText('Already recorded')).toBeVisible();
});

test('unauthenticated scan redirects to sign-in and resumes check-in', async ({ page }) => {
  const path = demo.venues.find((v) => v.key === 'amber')!.path;
  await page.goto(path);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('Email').fill('mei@demo.org');
  await page.getByLabel('Password').fill(demo.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await expect(page.getByRole('heading', { name: 'Science of the Soul – Amber' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm attendance' })).toBeVisible();
});

test('gate scanner: exit, entry, duplicate entry, revoked pass', async ({ page }) => {
  await signIn(page, 'desk');
  const scanAt = async (gateKey: string, passKey: string) => {
    await page.goto(`/staff/gate/${gate(gateKey)}`);
    const input = page.getByPlaceholder('Scan pass…');
    await input.fill(pass(passKey).pass_url);
    await input.press('Enter');
    const card = page.locator('.gate-result').filter({ hasNotText: 'Checking…' });
    await expect(card).toBeVisible();
    return card;
  };

  // Normalise Amara to OUTSIDE (exit is accepted or rejected depending on earlier runs).
  await scanAt('participant-exit', 'amara');
  await expect(await scanAt('participant-entry', 'amara')).toContainText('ENTRY OK');
  const dup = await scanAt('participant-entry', 'amara');
  await expect(dup).toContainText('STOP');
  await expect(dup).toContainText('Already inside');
  await expect(dup).toContainText('Amara Okafor');

  const revoked = await scanAt('participant-entry', 'sofia-old');
  await expect(revoked).toContainText('STOP');
  await expect(revoked).toContainText('revoked');
});

test('gate operator is limited to the assigned gate', async ({ page }) => {
  await signIn(page, 'gate');
  await page.goto(`/staff/gate/${gate('fair-lane')}`);
  await expect(page.getByText('You are not assigned to this gate.')).toBeVisible();
  await page.goto(`/staff/gate/${gate('participant-entry')}`);
  await expect(page.locator('.gate-mode')).toHaveText('ENTRY');
});

test('event dashboard and participant search', async ({ page }) => {
  await signIn(page, 'events');
  const summit = demo.events.find((e) => e.key === 'summit')!.id;
  await page.goto(`/admin/events/${summit}`);
  await expect(page.getByText('Inside now')).toBeVisible();
  await page.getByRole('link', { name: 'Participants' }).click();
  await page.getByPlaceholder('Name, reference, email or phone').fill('müller');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('link', { name: 'Lukas Müller' })).toBeVisible();
});

test('public registration works without an account', async ({ page }) => {
  const fair = demo.events.find((e) => e.key === 'fair')!.id;
  await page.goto(`/events/${fair}/register`);
  await expect(page.getByRole('heading', { name: 'Science of the Soul' })).toBeVisible();
  await page.getByLabel(/Full name/).fill(`E2E Visitor ${Date.now()}`);
  await page.getByLabel(/Phone/).fill(`+65 8${String(Date.now()).slice(-7)}`);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('You’re registered.')).toBeVisible();
  await expect(page.locator('.pass img')).toBeVisible();
});

test('admin pages render', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page, 'admin');
  for (const [path, heading] of [
    ['/admin/sessions', 'Sessions'],
    ['/admin/venues', 'Venues'],
    ['/admin/volunteers', 'People'],
    ['/admin/audit', 'Audit log'],
    ['/admin/events', 'Events'],
    ['/staff', 'Stations'],
  ]) {
    await page.goto(path);
    await expect(page.locator('.page-body').getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
