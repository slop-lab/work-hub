import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeRefSchema, type JsonObject, type RuntimeEvent } from '../../application/contracts/index.ts';
import { Store } from '../../application/persistence/database.ts';
import { ExecutionRepository } from '../../application/persistence/execution-repository.ts';
import { InteractionRepository } from '../../application/persistence/interaction-repository.ts';
import { LifecycleRepository } from '../../application/persistence/lifecycle-repository.ts';
import { ResultRepository } from '../../application/persistence/result-repository.ts';
import { StateRepository } from '../../application/persistence/state-repository.ts';
import { WorkRepository } from '../../application/persistence/work-repository.ts';
import { RuntimeEventReconciler } from '../../application/orchestration/runtime-event-reconciler.ts';
import { createTask, delegateNone, fixture, member } from '../acceptance-fixture.ts';

test('provider lifecycle metadata creates auditable recovery state without automatic retry or completion', async () => {
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, 'provider-lifecycle');
    const attempt = await delegateNone(f.hub, taskId, 'provider-lifecycle');
    const session = f.hub.getSession(member, attempt.sessionId).session;
    assert.ok(session.nativeIdentityKey);
    const store = new Store(f.path);
    try {
      const lifecycle = new LifecycleRepository(store.database, store.clock);
      const reconciler = new RuntimeEventReconciler({ state: new StateRepository(store.database, store.clock),
        execution: new ExecutionRepository(store.database, store.clock),
        interactions: new InteractionRepository(store.database, store.clock),
        results: new ResultRepository(store.database, store.clock), lifecycle,
        work: new WorkRepository(store.database, store.clock) });
      const nativeSession = NativeRefSchema.parse(JSON.parse(session.nativeIdentityKey));
      const event = (sourceEventId: string, namespace: string, data: JsonObject): RuntimeEvent => ({ sourceEventId,
        streamScope: session.id, nativeSession, bindingGeneration: session.bindingGeneration,
        observedAt: new Date().toISOString(), payload: { type: 'extension', namespace, data } });

      reconciler.apply(member.workspaceId, session.id, session.runtimeInstallationId,
        event('codex-retry', 'workhub.codex.lifecycle.v1', { kind: 'retry_observed', willRetry: true }));
      assert.equal(lifecycle.view(member.workspaceId, taskId).attempts.find((item) => item.id === attempt.id)?.recovery,
        'observe');
      reconciler.apply(member.workspaceId, session.id, session.runtimeInstallationId,
        event('claude-input', 'workhub.claude.lifecycle.v1', { kind: 'state', state: 'requires_action' }));

      const current = lifecycle.view(member.workspaceId, taskId).attempts.find((item) => item.id === attempt.id);
      assert.equal(current?.interruption, 'awaiting_input');
      assert.equal(current?.recovery, 'observe');
      assert.equal(f.hub.getTask(member, taskId).status, 'active');
    } finally { store.close(); }
  } finally { f.close(); }
});
