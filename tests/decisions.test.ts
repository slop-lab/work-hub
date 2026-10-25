import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { fixture, createTask, delegateNone } from './acceptance-fixture.ts';

test('a human completion note is exported as a canonical decision and never inherits another task’s stop operation', async () => {
  const context = fixture();
  try {
    const actor = context.hub.actorForUser('user-admin'); assert.ok(actor);
    const activeTask = await createTask(context.hub, 'decision-active', actor);
    await delegateNone(context.hub, activeTask, 'decision-active');
    const first = await context.hub.execute(actor, { commandId: 'decision-stop-active', type: 'task.setStatus', target: { kind: 'task', id: activeTask }, expected: { task: context.hub.getTask(actor, activeTask).revision }, payload: { status: 'done', activeExecutionDecision: 'request_stop' } });
    assert.equal(first.operationIds.length, 1);
    const ordinaryTask = await createTask(context.hub, 'decision-ordinary', actor);
    const second = await context.hub.execute(actor, { commandId: 'decision-complete-ordinary', type: 'task.setStatus', target: { kind: 'task', id: ordinaryTask }, expected: { task: 1 }, payload: { status: 'done', completionNote: 'Completed through human review.' } });
    assert.deepEqual(second.operationIds, []);
    const exported = z.object({ records: z.object({ entries: z.array(z.object({ taskId: z.string(), entryType: z.string(), bodyJson: z.string() })) }) }).parse(JSON.parse(context.hub.exportRecords(actor)));
    const decisions = exported.records.entries.filter((entry) => entry.taskId === ordinaryTask && entry.entryType === 'human_decision');
    assert.equal(decisions.length, 1);
    assert.equal(z.object({ completionNote: z.string() }).parse(JSON.parse(decisions[0]?.bodyJson ?? 'null')).completionNote, 'Completed through human review.');
  } finally { context.close(); }
});

test('a service principal without an explicit command allowlist cannot mutate work records', async () => {
  const context = fixture();
  try {
    const receipt = await context.hub.execute({ id: 'runtime-without-grants', workspaceId: 'workspace-default', role: 'runtime', projectIds: ['project-default'], profileIds: [], bindingIds: [] }, { commandId: 'unscoped-service-result', type: 'result.submit', target: { kind: 'attempt', id: 'not-authorized' }, payload: { summary: 'Must not persist', limitations: [], referenceIds: [], evidence: [] } });
    assert.equal(receipt.status, 'rejected');
    assert.equal(receipt.error?.category, 'authorization');
  } finally { context.close(); }
});
