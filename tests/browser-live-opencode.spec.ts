import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { startLiveHub } from './live-hub-fixture.ts';

const model = process.env['WORK_HUB_LIVE_MODEL'];
const agent = process.env['WORK_HUB_LIVE_AGENT'];
test('browser delegates to actual OpenCode, answers, reconnects and explicitly completes', async ({ page }, testInfo) => {
  test.skip(!model || !agent, 'Requires an explicitly selected available live model and agent.');
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  if (!model || !agent) throw new Error('Explicit live selection required');
  const app = await startLiveHub();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(app.url);
    await page.getByLabel('Bootstrap token').fill(app.token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Discover connections' }).click();
    await page.getByLabel('Runtime profile').selectOption(agent);
    await page.getByLabel('Connected model').selectOption({ label: model });
    await page.getByLabel('Work Hub project').selectOption('project-default');
    await page.getByRole('button', { name: 'Save execution profile' }).click();
    await expect(page.getByRole('strong').filter({ hasText: `Disposable native acceptance: ${agent}` })).toBeVisible();
    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await page.getByLabel('New task title').fill('Disposable native browser acceptance');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('button', { name: 'Open Disposable native browser acceptance' }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Disposable connector acceptance only. Use the native question tool to ask exactly one free-text question: Which browser marker? Wait for its answer, then return a short receipt. Do not delegate, run shell commands, use other tools or change files.');
    await page.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Task updated.');
    await page.getByRole('button', { name: 'Delegate', exact: true }).click();
    await page.getByLabel('Execution profile').selectOption({ label: `Disposable native acceptance: ${agent}` });
    await page.getByLabel('Environment choice').selectOption('none');
    await page.getByRole('button', { name: 'Confirm delegation' }).click();
    await page.getByRole('link', { name: 'Today', exact: true }).click();
    const answer = page.getByRole('button', { name: /Answer which browser marker/i });
    await expect(answer).toBeVisible({ timeout: 90_000 });
    const snapshot = z.object({ sessions: z.array(z.object({ id: z.string() })), requests: z.array(z.object({ id: z.string() })) })
      .parse(await (await page.request.get(`${app.url}/api/v1/state`)).json());
    const sessionId = snapshot.sessions[0]?.id;
    expect(sessionId).toBeTruthy();
    await app.restart();
    await page.reload();
    await answer.click();
    await page.getByRole('dialog').getByLabel('Answer').fill('browser-native-acceptance');
    await page.getByRole('button', { name: 'Save answer', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => app.hub().snapshot({ id: 'user-admin', workspaceId: 'workspace-default', role: 'administrator',
      projectIds: [], profileIds: [], bindingIds: [] }).results.length, { timeout: 90_000, intervals: [1000] }).toBe(1);
    await page.goto(`${app.url}/#/session/${sessionId}`);
    await expect(page.getByRole('heading', { name: 'Transcript', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open native OpenCode' })).toBeVisible();
    const output = z.object({ coverage: z.string(), gaps: z.array(z.object({ reason: z.string() })) })
      .parse(await (await page.request.get(`${app.url}/api/v1/sessions/${sessionId}/output`)).json());
    expect(output.coverage).toBe('partial');
    expect(output.gaps.length).toBeGreaterThan(0);
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: testInfo.outputPath(`live-session-${width}.png`) });
    }
    await page.getByRole('link', { name: 'Open task', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Follow-up acceptance only: provide a short summary of the browser marker already answered in this session. Do not ask a new question, delegate, use tools or change files.');
    await page.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Task updated.');
    await page.locator('#main-content').getByRole('link', { name: 'Session', exact: true }).click();
    await page.getByRole('button', { name: 'Continue session', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Continuation accepted');
    await expect.poll(() => app.hub().snapshot({ id: 'user-admin', workspaceId: 'workspace-default', role: 'administrator',
      projectIds: [], profileIds: [], bindingIds: [] }).results.length, { timeout: 90_000, intervals: [1000] }).toBe(2);
    await page.getByRole('link', { name: 'Open task', exact: true }).click();
    await page.getByLabel('Completion note').fill('Human checked the actual-service acceptance result.');
    await page.getByRole('button', { name: 'Complete task', exact: true }).last().click();
    await expect(page.getByText('done', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
