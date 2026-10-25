import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Hub } from '../application/orchestration/hub.ts';

test('output retention leaves an explicit gap and preserves canonical questions, responses and results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-retention-'));
  const hub = new Hub(join(root, 'hub.sqlite'));
  try {
    const actor = hub.actorForUser('user-admin'); assert.ok(actor);
    const task = await hub.execute(actor, { commandId: 'retention-task', type: 'task.create', payload: { projectId: 'project-default', title: 'Retain decisions' } });
    const taskId = task.objectRefs[0]?.id; assert.ok(taskId);
    await hub.execute(actor, { commandId: 'retention-delegate', type: 'attempt.delegate', target: { kind: 'task', id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: 'profile-structured', environment: { mode: 'none' }, selectedReferenceIds: [], selectedResponseIds: [] } });
    await hub.drain();
    const session = hub.snapshot(actor).sessions[0]; const attempt = hub.snapshot(actor).attempts[0];
    assert.ok(session); assert.ok(attempt); assert.ok(hub.simulator);
    const request = await hub.execute(actor, { commandId: 'retention-question', type: 'request.create', payload: { kind: 'question', projectId: 'project-default', taskId, recipient: { kind: 'project_members', projectId: 'project-default' }, prompt: 'Retained question', referenceIds: [], answerSchema: { kind: 'text', minLength: 1, maxLength: 100 }, blocking: 'none', validity: { kind: 'task', taskId } } });
    const requestId = request.objectRefs[0]?.id; assert.ok(requestId);
    await hub.execute(actor, { commandId: 'retention-answer', type: 'request.respond', target: { kind: 'request', id: requestId }, expected: { request: 1 }, payload: { answer: { kind: 'text', text: 'Keep the canonical record.' } } });
    await hub.execute(actor, { commandId: 'retention-result', type: 'result.submit', target: { kind: 'attempt', id: attempt.id }, payload: { summary: 'Retained summary', limitations: [], referenceIds: [], evidence: [{ origin: 'human_assertion', detail: 'Human recorded result.' }] } });
    for (let index = 0; index < 3; index += 1) hub.simulator.controls.emitOutput(session.id, String(index).repeat(50000));
    await hub.reconcile();
    const pruned = await hub.execute(actor, { commandId: 'retention-apply', type: 'retention.apply', payload: { maxBytes: 65536, maxAgeDays: 30 } });
    assert.equal(pruned.status, 'confirmed');
    const state = hub.snapshot(actor);
    const items = (state.output ?? []).map((row) => z.object({ kind: z.string(), text: z.string().optional() }).parse(JSON.parse(String(row['itemJson']))));
    assert.equal(items.some((item) => item.kind === 'gap'), true);
    assert.equal(items.filter((item) => item.kind === 'message').length, 1);
    assert.equal(items.find((item) => item.kind === 'message')?.text, '2'.repeat(50000));
    assert.equal(hub.getRequest(actor, requestId).status, 'answered');
    assert.equal(state.responses?.length, 1);
    assert.equal(state.results.length, 1);
  } finally { hub.close(); rmSync(root, { recursive: true }); }
});
