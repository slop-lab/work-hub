import { expect, test } from '@playwright/test';
import { startBrowserHub } from './browser-fixture.ts';

test('captured external revision identifiers reflow without expanding the mobile task column', async ({ page }) => {
  const app = await startBrowserHub(page);
  try {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await page.getByLabel('New task title').fill('External revision evidence');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('button', { name: 'Open External revision evidence', exact: true }).click();
    await page.getByLabel('Reference title').fill('Captured source digest');
    await page.getByLabel('Reference text').fill(`sha256:${'a'.repeat(64)}`);
    await page.getByRole('button', { name: 'Save reference', exact: true }).click();
    await expect(page.getByText('Captured source digest', { exact: true })).toBeVisible();
    const fits = await page.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth);
    expect(fits).toBe(true);
  } finally { await app.close(); }
});
