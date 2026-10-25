import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Hub } from '../application/orchestration/hub.ts';

test('retained references are durable task records and unsafe URLs never become fetch operations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-references-'));
  const hub = new Hub(join(root, 'hub.sqlite'));
  try {
    const actor = hub.actorForUser('user-admin'); assert.ok(actor);
    const task = await hub.execute(actor, { commandId: 'artifact-task', type: 'task.create', payload: { projectId: 'project-default', title: 'Retain evidence' } });
    const taskId = task.objectRefs[0]?.id; assert.ok(taskId);
    const created = await hub.execute(actor, { commandId: 'artifact-text', type: 'reference.create', target: { kind: 'task', id: taskId }, payload: { kind: 'text', title: 'Expected API', content: 'export const answer = 42;' } });
    assert.equal(created.status, 'confirmed');
    const id = created.objectRefs[0]?.id; assert.ok(id);
    assert.equal(hub.getReference(actor, id).retainedText, 'export const answer = 42;');
    const unsafe = await hub.execute(actor, { commandId: 'artifact-unsafe-link', type: 'reference.create', target: { kind: 'task', id: taskId }, payload: { kind: 'link', title: 'Unsafe', url: 'javascript:alert(1)' } });
    assert.equal(unsafe.error?.code, 'unsafe_reference_url');
    assert.equal(hub.simulator?.calls.list().length, 0);
    const exported = z.object({ records: z.object({ references: z.array(z.object({ retainedText: z.string().nullable() })) }) }).parse(JSON.parse(hub.exportRecords(actor)));
    assert.equal(exported.records.references[0]?.retainedText, 'export const answer = 42;');
  } finally { hub.close(); rmSync(root, { recursive: true }); }
});

test('selected reference content is copied into an immutable input snapshot rather than remembered by ID alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-context-copy-'));
  const hub = new Hub(join(root, 'hub.sqlite'));
  try {
    const actor = hub.actorForUser('user-admin'); assert.ok(actor);
    const task = await hub.execute(actor, { commandId: 'context-task', type: 'task.create', payload: { projectId: 'project-default', title: 'Use retained context' } });
    const taskId = task.objectRefs[0]?.id; assert.ok(taskId);
    const ref = await hub.execute(actor, { commandId: 'context-reference', type: 'reference.create', target: { kind: 'task', id: taskId }, payload: { kind: 'text', title: 'Contract fixture', content: '{"schemaVersion":7,"required":true}' } });
    const referenceId = ref.objectRefs[0]?.id; assert.ok(referenceId);
    const delegated = await hub.execute(actor, { commandId: 'context-delegate', type: 'attempt.delegate', target: { kind: 'task', id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: 'profile-structured', environment: { mode: 'none' }, selectedReferenceIds: [referenceId], selectedResponseIds: [] } });
    assert.equal(delegated.status, 'accepted');
    const attempt = hub.snapshot(actor).attempts[0]; assert.ok(attempt);
    const items = z.array(z.object({ sourceId: z.string(), sourceRevision: z.number().optional(), includedText: z.string().optional() })).parse(attempt.inputSnapshot['contextItems']);
    const retained = items.find((item) => item.sourceId === referenceId);
    assert.ok(retained);
    assert.equal(retained.sourceRevision, 1);
    assert.equal(retained.includedText?.includes('"schemaVersion":7'), true);
  } finally { hub.close(); rmSync(root, { recursive: true }); }
});
