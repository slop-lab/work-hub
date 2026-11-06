import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { z } from 'zod';

import { akbConnectionSchema } from '../../application/connectors/akb/index.ts';
import { createIsolatedAkbApplication } from '../../scripts/akb-verification-app.ts';

const request = { references: [{ kind: 'page' as const, id: 'page', revision: 2 },
  { kind: 'knowledge' as const, id: 'knowledge', revision: 1 }], maxBytes: 65536 };
const receiptSchema = z.object({ references: z.array(z.object({ id: z.string(), revision: z.literal(1) })) });

async function setup(pageTitle = 'Pinned Page') {
  let calls = 0;
  const items = request.references.map((reference) => ({ ...reference,
    schemaVersion: reference.kind === 'page' ? 'page.content.v1' : 'knowledge-object.r7.v1',
    revisionCreatedAt: new Date(0).toISOString(), snapshot: reference.kind === 'page'
      ? { title: pageTitle, document: { version: 1, blocks: [] } }
      : { candidate: { title: 'Knowledge', type: 'claim', statement: 'A retained claim.', status: 'proposed',
          confidence: 0.9, validityScope: 'fixture' }, sources: [], relations: [],
          acceptedProposalId: 'proposal', acceptedReviewId: 'review' },
  }));
  const server = createServer((incoming, response) => {
    calls += 1;
    response.setHeader('content-type', 'application/json');
    if (incoming.headers.authorization !== 'Bearer synthetic') { response.writeHead(401); response.end('{}'); return; }
    response.end(JSON.stringify({ scope: 'explicit-selection', references: request.references,
      selectionPage: null, items, maxBytes: 65536, contentBytes: Buffer.byteLength(JSON.stringify(items)) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const app = await createIsolatedAkbApplication((actor, projectId) => akbConnectionSchema.parse({
    installationId: 'akb', label: 'Wire fixture, not real AKB evidence', origin: `http://127.0.0.1:${address.port}`,
    authorization: 'Bearer synthetic', workspaceId: 'source-workspace', workHubWorkspaceId: actor.workspaceId,
    allowedProjectIds: [projectId], allowedUserIds: [actor.id], allowedPageIds: ['page'], allowedKnowledgeIds: ['knowledge'],
  }));
  return { app, calls: () => calls, async close() {
    await app.close(); server.close(); await once(server, 'close');
  } };
}

test('context API persists exact canonical sources and replays durable IDs without another provider read', async () => {
  const f = await setup();
  try {
    const path = `/tasks/${f.app.taskId}/external-context/akb/context`;
    const body = { commandId: 'capture-context', installationId: 'akb', contextRequest: request };
    const captured = await f.app.api({ path, body });
    assert.equal(captured.status, 201);
    const references = receiptSchema.parse(await captured.json()).references;
    assert.equal(references.length, 2);
    for (const [index, reference] of references.entries()) {
      const stored = await f.app.api({ path: `/references/${reference.id}` });
      assert.equal(stored.status, 200);
      const value = z.object({ contentRevision: z.string(), retainedText: z.string(),
        provenance: z.object({ sourceWorkspaceId: z.string(), contextDigest: z.string() }) }).parse(await stored.json());
      assert.equal(value.contentRevision, String(request.references[index]?.revision));
      assert.equal(value.provenance.sourceWorkspaceId, 'source-workspace');
      assert.match(value.provenance.contextDigest, /^sha256:/);
    }
    const beforeReplay = f.calls();
    await f.app.restart({ authorization: 'Bearer invalid' });
    const replay = await f.app.api({ path, body });
    assert.equal(replay.status, 201);
    assert.deepEqual(receiptSchema.parse(await replay.json()).references, references);
    assert.equal(f.calls(), beforeReplay);
    const changed = await f.app.api({ path, body: { ...body, contextRequest: { ...request, maxBytes: 65535 } } });
    assert.equal(changed.status, 409);
  } finally { await f.close(); }
});

test('context capture bounds local reference titles without modifying valid empty or long canonical Page titles', async () => {
  for (const title of ['', 'x'.repeat(600)]) {
    const f = await setup(title);
    try {
      const response = await f.app.api({ path: `/tasks/${f.app.taskId}/external-context/akb/context`, body: {
        commandId: 'title-capture', installationId: 'akb', contextRequest: request,
      } });
      assert.equal(response.status, 201);
      const first = receiptSchema.parse(await response.json()).references[0];
      assert.ok(first);
      const stored = z.object({ title: z.string(), retainedText: z.string() })
        .parse(await (await f.app.api({ path: `/references/${first.id}` })).json());
      assert.ok(stored.title.length > 0 && stored.title.length <= 500);
      assert.equal(z.object({ title: z.string() }).parse(JSON.parse(stored.retainedText)).title, title);
    } finally { await f.close(); }
  }
});

test('context APIs enforce local principal, project, workspace, installation and source scope before outbound requests', async () => {
  const f = await setup();
  try {
    const documents = `/external-context/akb/akb/documents?projectId=${f.app.projectId}&kind=page`;
    assert.equal((await f.app.api({ path: documents, principal: 'member' })).status, 403);
    assert.equal((await f.app.api({ path: '/external-context/akb/akb/documents?projectId=project-default&kind=page' })).status, 403);
    assert.equal((await f.app.api({ path: documents.replace('/akb/documents', '/missing/documents') })).status, 403);
    const outside = await f.app.api({ path: `/tasks/${f.app.taskId}/external-context/akb/context`, body: {
      commandId: 'outside', installationId: 'akb', contextRequest: {
        references: [{ kind: 'knowledge', id: 'outside-allowlist', revision: 1 }], maxBytes: 65536 },
    } });
    assert.equal(outside.status, 403);
    await f.app.restart({ workHubWorkspaceId: 'not-the-local-workspace' });
    assert.equal((await f.app.api({ path: documents })).status, 403);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
