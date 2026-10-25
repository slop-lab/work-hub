import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../application/persistence/database.ts';
import { StateRepository } from '../application/persistence/state-repository.ts';
import { createTask, fixture, member } from './acceptance-fixture.ts';

test('explicit reconciliation retries the original lookup after local reducer rollback', async () => {
  let now = new Date('2026-10-25T00:00:00Z');
  const f = fixture({ clock: { now: () => now } });
  try {
    f.hub.simulator?.controls.scriptNext('runtime.openSession', { kind: 'unknown_after_effect' });
    const taskId = await createTask(f.hub, 'reconcile-rollback');
    await f.hub.execute(member, { commandId: 'delegate-rollback', type: 'attempt.delegate',
      target: { kind: 'task', id: taskId }, expected: { task: 1, profile: 1 }, payload: {
        profileId: 'profile-structured', environment: { mode: 'none' }, selectedReferenceIds: [], selectedResponseIds: [],
      } });
    await f.hub.drain({ limit: 1 });
    const operation = f.hub.snapshot(member).operations?.find((item) => item['status'] === 'unknown');
    const id = operation?.['id'];
    assert.equal(typeof id, 'string');
    if (typeof id !== 'string') throw new TypeError('Original operation missing');
    const db = new DatabaseSync(f.path);
    try {
      db.prepare("UPDATE outbox SET next_due_at='9999-12-31T23:59:59.999Z' WHERE operation_id=?").run(id);
      db.exec("CREATE TRIGGER fail_reconcile_successor BEFORE INSERT ON outbox WHEN NEW.work_type='runtime.startAttempt' BEGIN SELECT RAISE(ABORT,'local reducer rollback'); END");
      await f.hub.execute(member, { commandId: 'reconcile-rollback', type: 'operation.reconcile', target: { kind: 'operation', id }, payload: {} });
      await f.hub.drain({ limit: 1 });
      db.exec('DROP TRIGGER fail_reconcile_successor');
      now = new Date(now.getTime() + 1_000);
      for (let index = 0; index < 4; index += 1) await f.hub.drain();
      assert.equal(f.hub.snapshot(member).attempts[0]?.phase, 'running');
      assert.equal(f.hub.simulator?.calls.list().filter((call) => call.operationKind === 'runtime.openSession').length, 1);
      assert.equal(f.hub.simulator?.calls.list().filter((call) => call.operationKind === 'runtime.startAttempt').length, 1);
    } finally { db.close(); }
  } finally { f.close(); }
});

test('legacy incarnation-less inbound events remain deduplicated after migration', () => {
  const f = fixture();
  const event = { streamScope: 'session', nativeSession: { installationId: 'runtime', providerScope: 'provider', kind: 'session', id: 'native' },
    bindingGeneration: 1, observedAt: '2026-10-25T00:00:00Z', payload: { type: 'extension', namespace: 'test', data: {} } };
  try {
    const db = new DatabaseSync(f.path);
    db.exec(`DROP TABLE inbound_events;
      CREATE TABLE inbound_events (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,installation_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,event_json TEXT NOT NULL,received_at TEXT NOT NULL,
        UNIQUE(installation_id,source_event_id,binding_generation));`);
    db.prepare('INSERT INTO inbound_events VALUES(?,?,?,?,?,?,?)').run('event', 'workspace-default', 'runtime', 'provider-local-1', 1, JSON.stringify(event), event.observedAt);
    db.close();
    const migrated = new Store(f.path);
    try {
      const state = new StateRepository(migrated.database, migrated.clock);
      let effects = 0;
      const claimed = state.claimInboundEvent({ workspaceId: 'workspace-default', installationId: 'runtime',
        sourceEventId: 'provider-local-1', bindingGeneration: 1, event }, () => { effects += 1; });
      assert.equal(claimed, false);
      assert.equal(effects, 0);
    } finally { migrated.close(); }
  } finally { f.close(); }
});
