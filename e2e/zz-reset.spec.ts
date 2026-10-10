import { expect, test } from '@playwright/test';

/**
 * "Reset demo data" button, clicked like a presenter would. Runs last in the
 * Chrome project (file name) so the suite leaves the demo freshly reset.
 */
test('reset demo data from the demo menu', async ({ page }) => {
  test.setTimeout(120_000); // the reset itself can take ~10–30 s
  // Leave a visible trace of an earlier demo: a session at Amber.
  await page.goto('/demo/weekly');
  await page.getByLabel('Session title').fill('Before reset');
  await page.getByRole('button', { name: /Create (& open|another) session/ }).click();
  await expect(page.getByText('Open now at')).toContainText('Before reset');

  await page.goto('/demo');
  await page.getByRole('button', { name: 'Reset demo data' }).click();
  await expect(page.getByRole('dialog', { name: 'Reset demo data?' })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, reset everything' }).click();
  // The dialog stays open until the reset finishes and the page reloads.
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 90_000 });
  // The laptop is signed back in as the (recreated) demo admin.
  await expect(page.locator('.demo-banner')).toContainText('signed in as Admin');

  await page.goto('/demo/weekly');
  await expect(page.getByText('Open now at')).not.toContainText('Before reset');
  await page.goto('/admin/venues');
  await expect(page.locator('tbody tr')).toHaveCount(2);
});
