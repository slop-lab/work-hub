import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTask, delegateNone, fixture, member } from './acceptance-fixture.ts';

test('a project member can inspect its operation context without unrelated workspace records', async () => {
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, 'operation-context');
    const attempt = await delegateNone(f.hub, taskId, 'operation-context');
    const operation = f.hub.snapshot(member).operations?.find((item) => item['targetId'] === attempt.id);
    assert.ok(operation);
    const id = operation['id'];
    assert.equal(typeof id, 'string');
    if (typeof id !== 'string') throw new TypeError('Operation ID missing');
    const context = f.hub.contextSnapshot(member, { route: 'operation', id });
    assert.equal(context.operations?.length, 1);
    assert.equal(context.tasks.length, 0);
  } finally { f.close(); }
});
