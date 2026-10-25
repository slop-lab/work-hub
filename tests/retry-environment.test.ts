import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admin, createTask, delegateProvisioned, drainIdle, finishAttempt, fixture, provisionedArea } from './acceptance-fixture.ts';

test('new-session retry uses the explicitly selected provisioned environment', async () => {
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, 'retry-environment');
    const previous = await delegateProvisioned(f.hub, taskId, 'retry-environment');
    await finishAttempt(f.hub, previous.attempt);
    const result = await f.hub.execute(admin, { commandId: 'retry-selected-environment', type: 'attempt.retry',
      target: { kind: 'attempt', id: previous.attempt.id }, expected: { task: f.hub.getTask(admin, taskId).revision, profile: 1 },
      payload: { predecessorId: previous.attempt.id, input: 'current_task', sameSession: false,
        environment: { mode: 'provision', executionInstallationId: 'execution-sim', externalProfileRef: 'small',
          parameters: {}, releasePolicyRef: 'retain', workAreas: [provisionedArea] } } });
    assert.equal(result.status, 'accepted');
    await drainIdle(f.hub);
    const next = f.hub.snapshot(admin).attempts.find((attempt) => attempt.id === result.objectRefs[0]?.id);
    assert.ok(next);
    assert.notEqual(next.sessionId, previous.session.id);
    assert.equal(next.phase, 'running');
    assert.equal(f.hub.snapshot(admin).environmentBindings.some((binding) => binding.attemptId === next.id && binding.state === 'attached'), true);
  } finally { f.close(); }
});
