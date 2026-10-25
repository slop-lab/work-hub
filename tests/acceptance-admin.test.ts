import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../application/orchestration/hub.ts';

test('administrative commands use the same durable idempotency and audit pipeline as task commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-admin-'));
  const path = join(root, 'hub.sqlite');
  const first = new Hub(path);
  const actor = first.actorForUser('user-admin');
  assert.ok(actor);
  const command = { commandId: 'create-project-once', type: 'project.create', payload: { name: 'Acceptance project', defaultProfileId: 'profile-structured' } };
  const saved = await first.execute(actor, command);
  assert.equal(saved.status, 'confirmed');
  first.close();
  const restored = new Hub(path);
  const replay = await restored.execute(actor, command);
  assert.deepEqual(replay, saved);
  const changed = await restored.execute(actor, { ...command, payload: { ...command.payload, name: 'Changed project' } });
  assert.equal(changed.error?.code, 'idempotency_key_conflict');
  assert.equal(restored.administration.projects.list(actor).filter((item) => item.name === 'Acceptance project').length, 1);
  assert.deepEqual(restored.getCommandReceipt(actor, command.commandId), saved);
  restored.close(); rmSync(root, { recursive: true });
});

test('AT-47: reading or dismissing a notification never resolves its canonical request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-view-state-'));
  const hub = new Hub(join(root, 'hub.sqlite'));
  try {
    const actor = hub.actorForUser('user-admin');
    assert.ok(actor);
    const receipt = await hub.execute(actor, { commandId: 'inbox-request', type: 'request.create', payload: { kind: 'question', projectId: 'project-default', recipient: { kind: 'project_members', projectId: 'project-default' }, prompt: 'Who should review this?', referenceIds: [], answerSchema: { kind: 'text', minLength: 1, maxLength: 200 }, blocking: 'none', validity: { kind: 'project', projectId: 'project-default' } } });
    const requestId = receipt.objectRefs[0]?.id;
    assert.ok(requestId);
    const attentionKey = `question:${requestId}:1`;
    await hub.execute(actor, { commandId: 'read-notification', type: 'attention.markRead', payload: { attentionKey } });
    await hub.execute(actor, { commandId: 'dismiss-notification', type: 'attention.dismiss', payload: { attentionKey } });
    assert.equal(hub.getRequest(actor, requestId).status, 'open');
    assert.equal(hub.getDashboard(actor).answerNeeded.some((item) => item.id === requestId), true);
    const state = hub.administration.views.list(actor).find((item) => item.attentionKey === attentionKey);
    assert.ok(state?.readAt); assert.ok(state.dismissedAt);
    assert.equal(hub.administration.views.list({ ...actor, id: 'another-human' }).length, 0);
  } finally { hub.close(); rmSync(root, { recursive: true }); }
});
