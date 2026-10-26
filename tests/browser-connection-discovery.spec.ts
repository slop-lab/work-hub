import { expect, test } from '@playwright/test';
import { startBrowserHub } from './browser-fixture.ts';

test('connection settings remain at the selected scroll position across background refresh', async ({ page }) => {
  const app = await startBrowserHub(page);
  try {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const heading = page.getByRole('heading', { name: 'Saved service connections', exact: true });
    await heading.evaluate((element) => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const main = page.getByRole('main');
    const original = await main.elementHandle();
    expect(original).not.toBeNull();
    const before = await main.evaluate((element) => element.scrollTop);
    expect(before).toBeGreaterThan(200);
    await page.waitForResponse((response) => response.url().includes('/api/v1/context'));
    await expect.poll(async () => original ? original.evaluate((element) => element.isConnected) : false).toBe(false);
    const after = await main.evaluate((element) => element.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(2);
  } finally { await app.close(); }
});
