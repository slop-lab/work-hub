import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';

import { HubError } from '../../application/domain/errors.ts';
import { RecipientHttp } from '../../application/integrations/recipient-http.ts';
import { createWorkHubTools } from '../../application/integrations/opencode-work-hub.ts';
import type { RecipientOperation } from '../../application/integrations/recipient-operations.ts';

test('global Work Hub tools bind calls to native SDK session context rather than agent-selected target IDs', async () => {
  const received: { readonly sessionId: string; readonly operation: RecipientOperation }[] = [];
  const tools = createWorkHubTools(async (sessionId, operation) => {
    received.push({ sessionId, operation });
    return { scope: sessionId, operation: operation.kind };
  });
  const context = { sessionID: 'ses_disposable', messageID: 'msg_disposable', agent: 'test', directory: '/fixture',
    worktree: '/fixture', abort: new AbortController().signal, metadata: () => undefined, ask: async () => undefined };
  assert.equal(await tools.workhub_assignment.execute({}, context), JSON.stringify({ scope: 'ses_disposable', operation: 'assignment' }));
  await tools.workhub_ack.execute({ deliveryDigest: 'sha256:exact-delivery' }, context);
  await tools.workhub_result.execute({ submissionKey: 'verification-report', kind: 'checkpoint',
    sourceCommit: 'a'.repeat(40), contextDigest: 'sha256:exact-context', outcome: 'partial', summary: 'Only local checks completed.', limitations: ['Native validation blocked.'],
    referenceIds: [], artifacts: [{ repositoryId: 'repo-one', sourceCommit: 'a'.repeat(40), path: 'docs/report.md' }],
    criterionEvidence: [],
    evidence: [{ origin: 'agent_claim', detail: 'Local evidence only.' }] }, context);
  assert.deepEqual(received.map((item) => item.sessionId), ['ses_disposable', 'ses_disposable', 'ses_disposable']);
  assert.deepEqual(received.map((item) => item.operation.kind), ['assignment', 'ack', 'result']);
  const result = received[2]?.operation;
  assert.ok(result?.kind === 'result');
  assert.equal(result.result.outcome, 'partial');
  assert.equal(result.result.sourceCommit, 'a'.repeat(40));
});

async function fixture(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Fixture address missing');
  return { origin: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test('recipient transport carries only the selected credential and parses the bounded reply', async () => {
  const source = await fixture((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-recipient');
    response.end(JSON.stringify({ assignment: 'attempt-one' }));
  });
  try {
    const result = await new RecipientHttp(source.origin).request({ method: 'POST', path: '/api/v1/recipient/exchange', authorization: 'Bearer synthetic-recipient', body: { nativeSessionId: 'ses_disposable' } });
    assert.deepEqual(result, { assignment: 'attempt-one' });
  } finally { await source.close(); }
});

test('recipient deadline covers a response whose headers arrive but JSON never completes', { timeout: 3000 }, async () => {
  const source = await fixture((_request, response) => { response.writeHead(200); response.write('{'); });
  try {
    await assert.rejects(new RecipientHttp(source.origin, { deadlineMs: 100, maxBytes: 1024 }).request({ method: 'GET', path: '/assignment', authorization: 'Bearer synthetic-recipient' }),
      (error: unknown) => error instanceof HubError && error.data.code === 'recipient_deadline');
  } finally { await source.close(); }
});

test('recipient transport rejects an oversized body without consuming unbounded content', async () => {
  const source = await fixture((_request, response) => { response.end(JSON.stringify({ content: 'x'.repeat(2048) })); });
  try {
    await assert.rejects(new RecipientHttp(source.origin, { deadlineMs: 1000, maxBytes: 1024 }).request({ method: 'GET', path: '/assignment', authorization: 'Bearer synthetic-recipient' }),
      (error: unknown) => error instanceof HubError && error.data.code === 'recipient_body_limit');
  } finally { await source.close(); }
});

test('recipient transport exposes safe HTTP status without provider text or private credentials', async () => {
  const source = await fixture((_request, response) => { response.writeHead(403); response.end('private-provider-secret'); });
  try {
    await assert.rejects(new RecipientHttp(source.origin).request({ method: 'GET', path: '/assignment', authorization: 'Bearer synthetic-recipient' }),
      (error: unknown) => error instanceof HubError && error.data.code === 'recipient_http_403' && !error.message.includes('private-provider-secret'));
  } finally { await source.close(); }
});
