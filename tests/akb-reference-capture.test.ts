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

test('AKB context capture atomically retains one canonical reference per actual source', () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), 'workhub-akb-context-'));
  const store = new Store(join(root, 'hub.sqlite'));
  const service = new ExternalCaptureService(store);
  const repository = new ReferenceRepository(store);
  const task = new WorkRepository(store.database, store.clock).createTask({ workspaceId: admin.workspaceId,
    projectId: 'project-default', title: 'Capture exact AKB context' });
  const selection = { commandId: 'capture-context', taskId: task.id, installationId: 'akb-one',
    contextRequest: { references: [
      { kind: 'page' as const, id: 'page-one', revision: 7 },
      { kind: 'knowledge' as const, id: 'decision-one', revision: 3 },
    ], maxBytes: 65_536 } };
  const sources = [
    { kind: 'page' as const, id: 'page-one', revision: 7, schemaVersion: 1,
      revisionCreatedAt: '2026-10-21T00:00:00.000Z', title: 'Runbook',
      canonicalData: { document: { version: 1, blocks: [] }, title: 'Runbook' } },
    { kind: 'knowledge' as const, id: 'decision-one', revision: 3, schemaVersion: 'knowledge.v1',
      revisionCreatedAt: '2026-10-22T00:00:00.000Z', title: 'Accepted decision',
      canonicalData: { candidate: { summary: 'Use the safe path.' }, status: 'accepted' } },
  ];
  try {
    // When
    const created = service.captureContext(admin, { ...selection, contentBytes: 247, sources });
    const replay = service.preflightContext(admin, selection);
    const references = created.map((item) => repository.get(admin, item.id));

    // Then
    assert.deepEqual(replay, created);
    assert.throws(() => service.preflightContext(admin, { ...selection,
      contextRequest: { ...selection.contextRequest, maxBytes: 32_768 } }), /different capture input/);
    assert.equal(references.length, 2);
    assert.equal(references[0]?.retainedText, JSON.stringify(sources[0]?.canonicalData));
    assert.equal(references[1]?.retainedText, JSON.stringify(sources[1]?.canonicalData));
    assert.deepEqual(references.map((item) => item.provenance), sources.map((source) => ({
      provider: 'akb', installationId: 'akb-one', kind: source.kind, id: source.id,
      revision: source.revision, schemaVersion: source.schemaVersion,
      revisionCreatedAt: source.revisionCreatedAt, retainedByHub: true,
      contentDigest: digest(JSON.stringify(source.canonicalData)),
    })));
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM references_store').get()?.['count'], 2);
    assert.equal(store.database.prepare("SELECT count(*) AS count FROM audit_entries WHERE action='reference.capture_context'").get()?.['count'], 1);
  } finally { store.close(); rmSync(root, { recursive: true }); }
});

test('AKB context capture rejects the whole invalid source set without partial persistence', () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), 'workhub-akb-context-atomic-'));
  const store = new Store(join(root, 'hub.sqlite'));
  const service = new ExternalCaptureService(store);
  const task = new WorkRepository(store.database, store.clock).createTask({ workspaceId: admin.workspaceId,
    projectId: 'project-default', title: 'Reject invalid AKB context' });
  const reference = { kind: 'page' as const, id: 'page-one', revision: 7 };
  try {
    // When / Then
    assert.throws(() => service.captureContext(admin, { commandId: 'capture-invalid-context', taskId: task.id,
      installationId: 'akb-one', contextRequest: { references: [reference], maxBytes: 65_536 },
      contentBytes: 100, sources: [
        { ...reference, schemaVersion: 1, revisionCreatedAt: '2026-10-21T00:00:00.000Z',
          title: 'Runbook', canonicalData: { title: 'Runbook' } },
        { ...reference, schemaVersion: 1, revisionCreatedAt: '2026-10-21T00:00:00.000Z',
          title: 'Duplicate', canonicalData: { title: 'Duplicate' } },
      ] }));
    assert.throws(() => service.captureContext(admin, { commandId: 'capture-over-budget-context', taskId: task.id,
      installationId: 'akb-one', contextRequest: { references: [reference], maxBytes: 64 },
      contentBytes: 65, sources: [{ ...reference, schemaVersion: 1,
        revisionCreatedAt: '2026-10-21T00:00:00.000Z', title: 'Runbook',
        canonicalData: { title: 'Runbook' } }] }));
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM references_store').get()?.['count'], 0);
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM command_receipts').get()?.['count'], 0);
  } finally { store.close(); rmSync(root, { recursive: true }); }
});
