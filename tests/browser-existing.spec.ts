import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { startBrowserHub } from './browser-fixture.ts';

test('existing-environment delegation pins the verified registration revision and never allocates a replacement', async ({ page }) => {
  const app = await startBrowserHub(page);
  try {
    await page.getByRole('link', { name: 'Environments', exact: true }).click();
    await page.getByLabel('Execution connector').selectOption('execution-sim');
    await page.getByLabel('Name', { exact: true }).fill('Existing browser workspace');
    await page.getByLabel('Provider locator').fill('existing-browser-workspace');
    await page.getByLabel('Allowed working directory').fill('/workspace/browser');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByRole('button', { name: 'Verify read-only', exact: true }).click();
    await expect(page.getByText('immutable', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await page.getByLabel('New task title').fill('Use verified existing contents');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('button', { name: 'Open Use verified existing contents' }).click();
    await page.getByRole('button', { name: 'Delegate', exact: true }).click();
    await page.getByLabel('Environment choice').selectOption('existing');
    await page.getByLabel('Existing registration').selectOption({ label: 'Existing browser workspace' });
    const accepted = page.waitForResponse((response) => response.url().endsWith('/api/v1/commands') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Confirm delegation', exact: true }).click();
    expect((await accepted).status()).toBe(202);
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.locator('#main-content').getByRole('link', { name: 'Session', exact: true }).click();
    await expect(page.getByText('running', { exact: true })).toBeVisible();
    const response = await page.request.get(`${app.url}/api/v1/simulator/calls`);
    const calls = z.object({ items: z.array(z.object({ operationKind: z.string() })) }).parse(await response.json()).items;
    expect(calls.some((call) => call.operationKind === 'execution.attach')).toBeTruthy();
    expect(calls.some((call) => call.operationKind === 'execution.requestAllocation')).toBeFalsy();
  } finally { await app.close(); }
});
