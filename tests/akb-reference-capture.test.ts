import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReferenceRepository } from '../application/artifacts/references.ts';
import { ExternalCaptureService } from '../application/artifacts/external-capture.ts';
import { Store } from '../application/persistence/database.ts';
import { WorkRepository } from '../application/persistence/work-repository.ts';
import { digest } from '../application/persistence/codec.ts';
import { admin } from './acceptance-fixture.ts';

test('external capture stores an immutable task reference with exact AKB provenance', () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), 'workhub-akb-reference-'));
  const store = new Store(join(root, 'hub.sqlite'));
  const repository = new ReferenceRepository(store);
  const task = new WorkRepository(store.database, store.clock).createTask({ workspaceId: admin.workspaceId,
    projectId: 'project-default', title: 'Use AKB context' });
  try {
    // When
    const created = repository.captureExternal(admin, { commandId: 'capture-runbook', taskId: task.id,
      installationId: 'akb-one', pageId: 'page-one', revision: 7,
      title: 'Runbook', retainedText: 'Deploy safely.',
      mimeType: 'text/plain', sourceRevision: '7', provenance: { provider: 'akb', installationId: 'akb-one',
        workspaceId: 'akb-workspace', pageId: 'page-one', revision: 7, sourceUpdatedAt: '2026-10-21T00:00:00.000Z' } });
    const reference = repository.get(admin, created.id);

    // Then
    assert.equal(reference.retainedText, 'Deploy safely.');
    assert.equal(reference.contentRevision, '7');
    assert.deepEqual(reference.provenance, { provider: 'akb', installationId: 'akb-one', workspaceId: 'akb-workspace',
      pageId: 'page-one', revision: 7, sourceUpdatedAt: '2026-10-21T00:00:00.000Z', retainedByHub: true,
      contentDigest: digest('Deploy safely.') });
  } finally { store.close(); rmSync(root, { recursive: true }); }
});

test('external capture preflight replays one durable receipt and conflicts on changed selection', () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), 'workhub-akb-preflight-'));
  const store = new Store(join(root, 'hub.sqlite'));
  const service = new ExternalCaptureService(store);
  const task = new WorkRepository(store.database, store.clock).createTask({ workspaceId: admin.workspaceId,
    projectId: 'project-default', title: 'Replay AKB context' });
  const selection = { commandId: 'capture-replay', taskId: task.id, installationId: 'akb-one',
    pageId: 'page-one', revision: 7 };
  try {
    const created = service.capture(admin, { ...selection, title: 'Runbook', retainedText: 'Deploy safely.',
      mimeType: 'text/plain', sourceRevision: '7', provenance: { provider: 'akb', installationId: 'akb-one',
        workspaceId: 'akb-workspace', pageId: 'page-one', revision: 7,
        sourceUpdatedAt: '2026-10-21T00:00:00.000Z' } });

    // When
    const replay = service.preflight(admin, selection);

    // Then
    assert.deepEqual(replay, created);
    assert.throws(() => service.preflight(admin, { ...selection, revision: 8 }), /different capture input/);
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM references_store').get()?.['count'], 1);
    assert.equal(store.database.prepare("SELECT count(*) AS count FROM audit_entries WHERE action='reference.capture'").get()?.['count'], 1);
  } finally { store.close(); rmSync(root, { recursive: true }); }
});
