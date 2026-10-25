import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Hub } from '../application/orchestration/hub.ts';
import { fixture, registerReadyEnvironment, writableArea } from './acceptance-fixture.ts';

test('simultaneous structured and limited installations keep their own capabilities without a global simulator override', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-hub-profile-isolation-'));
  const hub = new Hub(join(directory, 'hub.sqlite'));
  try {
    const actor = hub.actorForUser('user-admin'); assert.ok(actor);
    const tasks = [];
    for (const profileId of ['profile-structured', 'profile-limited']) {
      const saved = await hub.execute(actor, { commandId: `create-${profileId}`, type: 'task.create', payload: { projectId: 'project-default', title: profileId } });
      const taskId = saved.objectRefs[0]?.id; assert.ok(taskId);
      tasks.push({ taskId, profileId });
      const receipt = await hub.execute(actor, { commandId: `delegate-${profileId}`, type: 'attempt.delegate', target: { kind: 'task', id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId, environment: { mode: 'none' }, selectedReferenceIds: [], selectedResponseIds: [] } });
      assert.equal(receipt.status, 'accepted');
    }
    await hub.drain();
    const snapshot = hub.snapshot(actor);
    for (const entry of tasks) {
      const session = snapshot.sessions.find((item) => item.taskId === entry.taskId); assert.ok(session);
      const modes = z.object({ activeInputModes: z.array(z.string()) }).parse(session.capabilities).activeInputModes;
      assert.equal(modes.includes('immediate'), entry.profileId === 'profile-structured');
      const attemptId = session.activeAttemptId; assert.ok(attemptId);
      const instruction = await hub.execute(actor, { commandId: `instruct-${entry.profileId}`, type: 'session.instruct', target: { kind: 'session', id: session.id }, expected: { bindingGeneration: session.bindingGeneration }, payload: { attemptId, text: 'Exercise declared timing', referenceIds: [], mode: 'immediate' } });
      assert.equal(instruction.status, entry.profileId === 'profile-structured' ? 'accepted' : 'rejected');
    }
  } finally { hub.close(); rmSync(directory, { recursive: true }); }
});

test('profile configuration refuses a required capability that the selected limited installation cannot provide', async () => {
  const context = fixture();
  try {
    const actor = context.hub.actorForUser('user-admin'); assert.ok(actor);
    const result = await context.hub.execute(actor, { commandId: 'unsupported-capability-profile', type: 'profile.create', payload: { label: 'Requires native approval', runtimeInstallationId: 'runtime-sim-limited', allowedEnvironmentModes: ['none'], defaultEnvironment: { mode: 'none' }, requiredCapabilities: ['nativeApprovals'] } });
    assert.equal(result.status, 'rejected');
    assert.equal(result.error?.code, 'required_capability_unavailable');
    assert.equal(context.hub.snapshot(actor).profiles.length, 2);
    assert.equal(context.hub.simulator?.calls.list().length, 0);
  } finally { context.close(); }
});

test('a profile granting only task reads cannot acquire an existing writable environment through omitted effect fields', async () => {
  const context = fixture();
  try {
    const actor = context.hub.actorForUser('user-admin'); assert.ok(actor);
    const registrationId = await registerReadyEnvironment(context.hub, 'read-profile-boundary');
    const registration = context.hub.getEnvironmentRegistration(actor, registrationId);
    const changed = await context.hub.execute(actor, { commandId: 'read-profile-only', type: 'profile.update', target: { kind: 'profile', id: 'profile-structured' }, expected: { profile: 1 }, payload: { allowedEffects: ['task.read'] } });
    assert.equal(changed.status, 'confirmed');
    const saved = await context.hub.execute(actor, { commandId: 'read-only-task', type: 'task.create', payload: { projectId: 'project-default', title: 'Respect the profile grant' } });
    const taskId = saved.objectRefs[0]?.id; assert.ok(taskId);
    const refused = await context.hub.execute(actor, { commandId: 'write-through-read-profile', type: 'attempt.delegate', target: { kind: 'task', id: taskId }, expected: { task: 1, profile: 2, registration: registration.revision }, payload: { profileId: 'profile-structured', environment: { mode: 'existing', registrationId, expectedRegistrationRevision: registration.revision, workAreas: [writableArea], requestedAccess: 'write' }, selectedReferenceIds: [], selectedResponseIds: [] } });
    assert.equal(refused.error?.code, 'effect_not_authorized');
    assert.equal(context.hub.snapshot(actor).attempts.length, 0);
    assert.equal(context.hub.simulator?.calls.list().some((call) => call.operationKind === 'execution.attach'), false);
  } finally { context.close(); }
});
