import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../application/orchestration/hub.ts';
import { NativeRefSchema } from '../application/contracts/index.ts';
import { digest } from '../application/persistence/codec.ts';

test('a request cannot inject a blocker into a task in another project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-context-'));
  const hub = new Hub(join(root, 'hub.sqlite'));
  try {
    const admin = hub.actorForUser('user-admin'); assert.ok(admin);
    const project = await hub.execute(admin, { commandId: 'other-project', type: 'project.create', payload: { name: 'Other project' } });
    const projectId = project.objectRefs[0]?.id; assert.ok(projectId);
    const task = await hub.execute(admin, { commandId: 'other-task', type: 'task.create', payload: { projectId, title: 'Private project work' } });
    const taskId = task.objectRefs[0]?.id; assert.ok(taskId);
    const receipt = await hub.execute({ ...admin, id: 'scoped-member', role: 'member', projectIds: ['project-default'] },
      { commandId: 'cross-project-blocker', type: 'request.create', payload: { kind: 'question', projectId: 'project-default', taskId, recipient: { kind: 'project_members', projectId: 'project-default' }, prompt: 'This must not block another project', referenceIds: [], answerSchema: { kind: 'text', minLength: 1, maxLength: 100 }, blocking: 'before_delegate', validity: { kind: 'task', taskId } } });
    assert.equal(receipt.status, 'rejected');
    assert.equal(hub.snapshot(admin).requests.length, 0);
  } finally { hub.close(); rmSync(root, { recursive: true }); }
});

test('another project member cannot withdraw someone else’s blocking decision request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-withdraw-'));
  const hub = new Hub(join(root, 'hub.sqlite'));
  try {
    const admin = hub.actorForUser('user-admin'); assert.ok(admin);
    const request = await hub.execute(admin, { commandId: 'owned-question', type: 'request.create', payload: { kind: 'question', projectId: 'project-default', recipient: { kind: 'project_members', projectId: 'project-default' }, prompt: 'Preserve this decision', referenceIds: [], answerSchema: { kind: 'text', minLength: 1, maxLength: 100 }, blocking: 'before_delegate', validity: { kind: 'project', projectId: 'project-default' } } });
    const requestId = request.objectRefs[0]?.id; assert.ok(requestId);
    const receipt = await hub.execute({ ...admin, id: 'another-member', role: 'member' }, { commandId: 'unauthorized-withdraw', type: 'request.withdraw', target: { kind: 'request', id: requestId }, expected: { request: 1 }, payload: { reason: 'Bypass the blocker' } });
    assert.equal(receipt.error?.category, 'authorization');
    assert.equal(hub.getRequest(admin, requestId).status, 'open');
  } finally { hub.close(); rmSync(root, { recursive: true }); }
});

test('an approval that expires after commitment is suppressed before native delivery, without changing the answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-approval-expiry-'));
  let now = Date.parse('2026-10-25T00:00:00.000Z');
  const hub = new Hub(join(root, 'hub.sqlite'), { clock: { now: () => new Date(now) } });
  try {
    const admin = hub.actorForUser('user-admin'); assert.ok(admin);
    const task = await hub.execute(admin, { commandId: 'approval-task', type: 'task.create', payload: { projectId: 'project-default', title: 'Scoped action' } });
    const taskId = task.objectRefs[0]?.id; assert.ok(taskId);
    await hub.execute(admin, { commandId: 'approval-delegate', type: 'attempt.delegate', target: { kind: 'task', id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: 'profile-structured', environment: { mode: 'none' }, selectedReferenceIds: [], selectedResponseIds: [] } });
    await hub.drain();
    const snapshot = hub.snapshot(admin);
    const session = snapshot.sessions[0]; const attempt = snapshot.attempts[0];
    assert.ok(session); assert.ok(attempt); assert.ok(session.nativeIdentityKey);
    const nativeSession = NativeRefSchema.parse(JSON.parse(session.nativeIdentityKey));
    const action = { effect: 'work.write', resource: 'simulated-action-one' };
    const request = await hub.execute(admin, { commandId: 'action-approval', type: 'request.create', payload: { kind: 'approval', projectId: 'project-default', taskId, sessionId: session.id, attemptId: attempt.id, bindingGeneration: session.bindingGeneration, recipient: { kind: 'user', userId: admin.id }, prompt: 'Approve this exact simulated action?', referenceIds: [],
      answerSchema: { kind: 'approval', allowed: ['approve', 'deny'] }, blocking: 'runtime_action', responseRoute: 'native', actionDescription: action,
      validity: { kind: 'attempt', target: { hubSessionId: session.id, hubAttemptId: attempt.id, nativeSession, bindingGeneration: session.bindingGeneration, controlGrantRef: `control:${session.id}` }, nativeRequestRef: { ...nativeSession, kind: 'request', id: 'native-action-one' }, actionDigest: digest(action), policyRevision: '1',
        environmentIdentities: [], expiresAt: new Date(now + 1000).toISOString() } } });
    assert.equal(request.status, 'confirmed');
    const requestId = request.objectRefs[0]?.id; assert.ok(requestId);
    const answer = await hub.execute(admin, { commandId: 'approve-action', type: 'request.respond', target: { kind: 'request', id: requestId }, expected: { request: 1, bindingGeneration: session.bindingGeneration }, payload: { answer: { kind: 'approval', decision: 'approve' } } });
    assert.equal(answer.confirmedEffect, 'response.persisted');
    assert.equal(answer.status, 'confirmed');
    now += 1001;
    await hub.drain();
    assert.equal(hub.simulator?.calls.list().filter((call) => call.operationKind === 'runtime.deliverResponse').length, 0);
    assert.equal(hub.getRequest(admin, requestId).status, 'answered');
    assert.equal(hub.snapshot(admin).responses?.length, 1);
    assert.equal(hub.snapshot(admin).deliveries?.[0]?.['status'], 'suppressed');
  } finally { hub.close(); rmSync(root, { recursive: true }); }
});

test('snapshot and dashboard projections never expose another project’s questions or work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-query-scope-'));
  const hub = new Hub(join(root, 'hub.sqlite'));
  try {
    const admin = hub.actorForUser('user-admin'); assert.ok(admin);
    const project = await hub.execute(admin, { commandId: 'private-project', type: 'project.create', payload: { name: 'Private project' } });
    const projectId = project.objectRefs[0]?.id; assert.ok(projectId);
    const task = await hub.execute(admin, { commandId: 'private-task', type: 'task.create', payload: { projectId, title: 'Private work' } });
    const taskId = task.objectRefs[0]?.id; assert.ok(taskId);
    await hub.execute(admin, { commandId: 'private-question', type: 'request.create', payload: { kind: 'question', projectId, taskId, recipient: { kind: 'project_members', projectId }, prompt: 'Private question', referenceIds: [], answerSchema: { kind: 'text', minLength: 1, maxLength: 100 }, blocking: 'none', validity: { kind: 'task', taskId } } });
    const member = { ...admin, id: 'scoped-member', role: 'member', projectIds: ['project-default'] } as const;
    assert.equal(hub.snapshot(member).requests.length, 0);
    assert.equal(hub.snapshot(member).tasks.length, 0);
    assert.equal(hub.getDashboard(member).answerNeeded.length, 0);
    assert.equal(hub.contextSnapshot(member, { route: 'dashboard' }).requests.length, 0);
    const removedProjectAccess = { ...admin, role: 'member', projectIds: ['project-default'] } as const;
    const personal = await hub.execute(admin, { commandId: 'private-personal-question', type: 'request.create', payload: { kind: 'question', projectId, taskId, recipient: { kind: 'user', userId: admin.id }, prompt: 'Private personal question', referenceIds: [], answerSchema: { kind: 'text', minLength: 1, maxLength: 100 }, blocking: 'none', validity: { kind: 'task', taskId } } });
    assert.equal(personal.status, 'confirmed');
    assert.equal(hub.contextSnapshot(removedProjectAccess, { route: 'dashboard' }).requests.length, 0);
  } finally { hub.close(); rmSync(root, { recursive: true }); }
});
