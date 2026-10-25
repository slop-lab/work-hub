import { expect, test } from '@playwright/test';
import { startBrowserHub } from './browser-fixture.ts';

test('hostile runtime markup remains visible text rather than executable browser content', async ({ page }) => {
  const app = await startBrowserHub(page);
  try {
    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await page.getByLabel('New task title').fill('Inert runtime output');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('button', { name: 'Open Inert runtime output' }).click();
    await page.getByRole('button', { name: 'Delegate', exact: true }).click();
    await page.getByLabel('Environment choice').selectOption('none');
    await page.getByRole('button', { name: 'Confirm delegation' }).click();
    await page.locator('#main-content').getByRole('link', { name: 'Session', exact: true }).click();
    await expect(page.getByText('running', { exact: true })).toBeVisible();
    const sessionId = page.url().split('/').at(-1);
    expect(sessionId).toBeTruthy();
    const text = '<img id="runtime-injection" src="missing" onerror="window.runtimeInjected=true"><script>window.runtimeInjected=true</script>';
    const response = await page.request.post(`${app.url}/api/v1/simulator/commands`, {
      headers: { Origin: app.url }, data: { type: 'output', sessionId, text },
    });
    expect(response.ok()).toBeTruthy();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    await expect(page.locator('#runtime-injection')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'runtimeInjected'))).toBeUndefined();
    const document = await page.request.get(app.url);
    expect(document.headers()['content-security-policy']).toContain("script-src 'self'");
  } finally { await app.close(); }
});
