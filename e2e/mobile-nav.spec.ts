import { devices, expect, test } from '@playwright/test';

/** Phone navigation (≤640px): top bar + slide-out menu, on a short phone. */
test('phone menu: opens, Sign out always visible, closes on navigation, signs out', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ ...devices['iPhone SE'], baseURL });
  const page = await ctx.newPage();
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@demo.org', password: 'demo1234' },
    headers: { 'X-Requested-With': 'fetch' },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto('/admin/sessions');
  await expect(page.locator('.mobile-bar')).toContainText('Sessions');
  await expect(page.locator('.shell-sidebar')).toHaveCount(0); // no desktop sidebar on phones

  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu.getByRole('button', { name: 'Sign out' })).toBeInViewport();

  await menu.getByRole('button', { name: 'Venues' }).click();
  await expect(page).toHaveURL(/\/admin\/venues$/);
  await expect(page.locator('.mmenu.open')).toHaveCount(0);
  await expect(page.locator('.mobile-bar')).toContainText('Venues');

  await page.getByRole('button', { name: 'Open menu' }).click();
  await menu.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});
