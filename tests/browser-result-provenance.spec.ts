import { expect, test } from '@playwright/test';
import { startBrowserHub } from './browser-fixture.ts';
import { admin, createTask, delegateNone } from './acceptance-fixture.ts';

test('result review retains author, attempt, evidence origin and reference availability', async ({ page }) => {
  const app = await startBrowserHub(page);
  try {
    const taskId = await createTask(app.hub, 'result-provenance');
    const attempt = await delegateNone(app.hub, taskId, 'result-provenance');
    const reference = await app.hub.execute(admin, { commandId: 'result-reference', type: 'reference.create',
      target: { kind: 'task', id: taskId }, payload: { kind: 'text', title: 'Retained acceptance notes', content: 'Human review notes.' } });
    const referenceId = reference.objectRefs[0]?.id;
    if (referenceId === undefined) throw new TypeError('Reference was not created');
    await app.hub.execute(admin, { commandId: 'result-provenance', type: 'result.submit',
      target: { kind: 'attempt', id: attempt.id }, payload: { summary: 'Review the proposed outcome', limitations: [],
        referenceIds: [referenceId], evidence: [{ origin: 'human_assertion', detail: 'Verified manually against the retained notes.' }] } });
    await page.goto(`${app.url}/#/backlog/${taskId}`);
    const card = page.locator('.result-card');
    await expect(card.getByText('Administrator', { exact: false })).toBeVisible();
    await expect(card.getByText(attempt.id, { exact: false })).toBeVisible();
    await expect(card.getByText('Human assertion', { exact: false })).toBeVisible();
    await expect(card.getByText('Verified manually against the retained notes.', { exact: true })).toBeVisible();
    await expect(card.getByText('Retained acceptance notes', { exact: false })).toBeVisible();
    await expect(card.getByText(/available|retained/i).last()).toBeVisible();
  } finally { await app.close(); }
});
