import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admin, createTask, fixture } from './acceptance-fixture.ts';

test('verified external capture persists one audited command and replays its reference', async () => {
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, 'external-capture-command');
    const input = { commandId: 'capture-command', taskId, installationId: 'source', pageId: 'page', revision: 12,
      title: 'Selected source', retainedText: 'Captured revision text',
      mimeType: 'text/plain', sourceRevision: '12', provenance: { provider: 'akb', installationId: 'source', pageId: 'page', revision: 12 } };
    const first = f.hub.captureExternalReference(admin, input);
    const replay = f.hub.captureExternalReference(admin, input);
    assert.equal(replay.id, first.id);
    assert.equal(f.hub.snapshot(admin).references?.length, 1);
    assert.equal(f.hub.getCommandReceipt(admin, input.commandId)?.confirmedEffect, 'reference.persisted');
    assert.throws(() => f.hub.captureExternalReference(admin, { ...input, pageId: 'different-page' }));
    assert.equal(f.hub.snapshot(admin).references?.length, 1);
  } finally { f.close(); }
});
