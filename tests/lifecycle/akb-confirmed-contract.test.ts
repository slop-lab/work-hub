import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { AkbClient, akbConnectionSchema } from '../../application/connectors/akb/index.ts';
import { HubError } from '../../application/domain/errors.ts';

const selection = { references: [{ kind: 'page' as const, id: 'page', revision: 2 },
  { kind: 'knowledge' as const, id: 'knowledge', revision: 1 }], maxBytes: 65536 };

function contextResponse() {
  const items = [
    { kind: 'page', id: 'page', revision: 2, schemaVersion: 'page.content.v1',
      revisionCreatedAt: new Date(0).toISOString(), snapshot: { title: 'Pinned Page',
        document: { version: 1, blocks: [] } } },
    { kind: 'knowledge', id: 'knowledge', revision: 1, schemaVersion: 'knowledge-object.r7.v1',
      revisionCreatedAt: new Date(0).toISOString(), snapshot: { candidate: { title: 'Accepted Knowledge', type: 'claim',
        statement: 'A retained claim.', status: 'proposed', confidence: 0.9, validityScope: 'fixture' },
        sources: [], relations: [], acceptedProposalId: 'proposal', acceptedReviewId: 'review' } },
  ];
  return { scope: 'explicit-selection', references: selection.references, selectionPage: null,
    items, contentBytes: Buffer.byteLength(JSON.stringify(items)), maxBytes: 65536 };
}

async function fixture() {
  let payload: (url: string) => unknown = () => contextResponse();
  let status = 200;
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload(request.url ?? '')));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new AkbClient(akbConnectionSchema.parse({ installationId: 'akb', label: 'AKB contract fixture',
    origin: `http://127.0.0.1:${address.port}`, authorization: 'Bearer synthetic', workspaceId: 'akb-workspace',
    workHubWorkspaceId: 'workspace-default', allowedProjectIds: ['project-default'],
    allowedPageIds: ['page', 'page-two'], allowedKnowledgeIds: ['knowledge'] }));
  return { client, calls, respond(value: unknown) { payload = () => value; },
    respondWith(value: (url: string) => unknown) { payload = value; }, status(value: number) { status = value; },
    async close() { server.close(); await once(server, 'close'); } };
}

test('confirmed AKB context retains ordered canonical snapshots rather than requiring Page read DTO metadata', async () => {
  const f = await fixture();
  try { assert.deepEqual(await f.client.readContext(selection), contextResponse()); }
  finally { await f.close(); }
});

test('confirmed AKB discovery parses live pagination and filters explicit source allowlists', async () => {
  const f = await fixture();
  try {
    f.respondWith((url) => {
      const after = new URL(url, 'http://fixture').searchParams.get('afterId');
      const item = after === null ? { kind: 'page', id: 'page', title: 'Allowed', revision: 3, lifecycle: 'active' }
        : after === 'page' ? { kind: 'page', id: 'not-allowed', title: 'Hidden locally', revision: 1, lifecycle: 'active' }
          : { kind: 'page', id: 'page-two', title: 'Also allowed', revision: 1, lifecycle: 'active' };
      return { items: [item], nextAfterId: after === 'not-allowed' ? null : item.id, consistency: 'live' };
    });
    assert.deepEqual(await f.client.findDocuments({ kind: 'page', query: '', limit: 1 }), {
      items: [{ kind: 'page', id: 'page', title: 'Allowed', revision: 3, lifecycle: 'active' }],
      nextAfterId: 'page', consistency: 'live',
    });
    const next = await f.client.findDocuments({ kind: 'page', query: '', limit: 1, afterId: 'page' });
    assert.deepEqual(next, { items: [{ kind: 'page', id: 'page-two', title: 'Also allowed', revision: 1, lifecycle: 'active' }],
      nextAfterId: null, consistency: 'live' });
    assert.equal(JSON.stringify(next).includes('not-allowed'), false);
    const before = f.calls.length;
    await assert.rejects(f.client.findDocuments({ kind: 'page', query: '', limit: 1, afterId: 'not-allowed' }));
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test('AKB discovery and Knowledge errors identify an unavailable source without claiming it is a Page or context', async () => {
  const f = await fixture();
  try {
    f.status(404);
    for (const read of [() => f.client.findDocuments({ kind: 'knowledge', query: '', limit: 1 }),
      () => f.client.readKnowledgeRevision('knowledge', 999)]) {
      await assert.rejects(read(), (error: unknown) => error instanceof HubError &&
        error.data.code === 'akb_source_unavailable' && !error.message.includes('Page') && !error.message.includes('context'));
    }
  } finally { await f.close(); }
});

test('AKB rejects source IDs outside the configured allowlist before context transport', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.client.readContext({ references: [{ kind: 'knowledge', id: 'not-allowed', revision: 1 }], maxBytes: 65536 }),
      (error: unknown) => error instanceof HubError && error.data.code === 'akb_source_outside_scope');
    await assert.rejects(f.client.readPage('not-allowed'), (error: unknown) =>
      error instanceof HubError && error.data.code === 'akb_page_outside_scope');
    const pageOnly = new AkbClient({ ...f.client.connection, allowedKnowledgeIds: [] });
    await assert.rejects(pageOnly.findDocuments({ kind: 'knowledge', query: '', limit: 20 }),
      (error: unknown) => error instanceof HubError && error.data.code === 'akb_source_outside_scope');
    await assert.rejects(f.client.readContext({ selectionPage: { id: 'page', revision: 2 }, maxBytes: 65536 }),
      (error: unknown) => error instanceof HubError && error.data.code === 'akb_context_requires_explicit_selection');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('AKB context rejects tampered byte counts and substituted or reordered identities', async () => {
  const f = await fixture();
  try {
    const valid = contextResponse();
    for (const payload of [
      { ...valid, contentBytes: valid.contentBytes + 1 },
      { ...valid, items: [...valid.items].reverse() },
      { ...valid, references: [...valid.references].reverse() },
      { ...valid, maxBytes: 65535 },
    ]) {
      f.respond(payload);
      await assert.rejects(f.client.readContext(selection), (error: unknown) =>
        error instanceof HubError && error.data.code === 'akb_context_identity_mismatch');
    }
  } finally { await f.close(); }
});

test('exact Page DTO parsing preserves owner-valid empty and long titles independently of local reference labels', async () => {
  const f = await fixture();
  try {
    for (const title of ['', 'x'.repeat(10001)]) {
      f.respond({ page: { id: 'page', workspaceId: 'akb-workspace', spaceId: null, parentPageId: null,
        title, revision: 2, lifecycle: 'active', document: { version: 1, blocks: [] },
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } });
      assert.equal((await f.client.readPageRevision('page', 2)).title, title);
    }
  } finally { await f.close(); }
});
