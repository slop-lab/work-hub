import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { test } from 'node:test';
import {
  AkbClient,
  akbConnectionSchema,
  akbContextRequestSchema,
  akbDocumentQuerySchema,
} from '../application/connectors/akb/index.ts';
import { HubError } from '../application/domain/errors.ts';

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function connection(origin: string) {
  return akbConnectionSchema.parse({ installationId: 'source', label: 'AKB', origin,
    authorization: 'Bearer synthetic-private-value', workspaceId: 'source-workspace',
    allowedPageIds: ['page'], workHubWorkspaceId: 'workspace-default',
    allowedProjectIds: ['project-default'] });
}

test('AKB document and context requests enforce handbook limits before transport', () => {
  // Given
  const references = Array.from({ length: 25 }, (_, index) => ({
    kind: index % 2 === 0 ? 'page' as const : 'knowledge' as const,
    id: `source-${index}`,
    revision: index + 1,
  }));

  // When / Then
  assert.equal(akbDocumentQuerySchema.parse({ kind: 'page', query: 'runbook', limit: 25 }).limit, 25);
  const parsed = akbContextRequestSchema.parse({ references, maxBytes: 262_144 });
  assert.ok('references' in parsed);
  assert.equal(parsed.references.length, 25);
  assert.equal(akbContextRequestSchema.parse({ references: [references[0]] }).maxBytes, 65_536);
  assert.throws(() => akbContextRequestSchema.parse({ references: [...references, {
    kind: 'page', id: 'overflow', revision: 1 }], maxBytes: 64 * 1024 }));
  assert.throws(() => akbContextRequestSchema.parse({ references: [references[0], references[0]], maxBytes: 64 * 1024 }));
  assert.throws(() => akbContextRequestSchema.parse({ references: [], maxBytes: 262_145 }));
  assert.throws(() => akbContextRequestSchema.parse({ references: [references[0]],
    selectionPage: { id: 'selection', revision: 1 } }));
});

test('AKB context transport posts the exact selection and reports one generic unavailable failure', async () => {
  // Given
  let observedMethod = '';
  let observedUrl = '';
  let observedBody = '';
  const server = createServer(async (request, response) => {
    observedMethod = request.method ?? '';
    observedUrl = request.url ?? '';
    observedBody = await requestBody(request);
    response.statusCode = 404;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'must not escape' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Fixture did not listen');
  const client = new AkbClient(connection(`http://127.0.0.1:${address.port}/`));
  const selection = { selectionPage: { id: 'selection-page', revision: 4 }, maxBytes: 65_536 } as const;
  try {
    // When / Then
    await assert.rejects(client.readContext(selection), (error: unknown) => error instanceof HubError &&
      error.data.code === 'akb_context_unavailable' && !error.message.includes('must not escape'));
    assert.equal(observedMethod, 'POST');
    assert.equal(observedUrl, '/api/content/v1/workspaces/source-workspace/context');
    assert.deepEqual(JSON.parse(observedBody), selection);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('AKB document discovery uses the owned endpoint and fails closed without the exact response DTO', async () => {
  // Given
  let observedUrl = '';
  const server = createServer((request, response) => {
    observedUrl = request.url ?? '';
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Fixture did not listen');
  const client = new AkbClient(connection(`http://127.0.0.1:${address.port}/`));
  try {
    // When / Then
    await assert.rejects(client.findDocuments({ kind: 'knowledge', query: 'decision', limit: 10,
      afterId: 'knowledge-4' }), (error: unknown) => error instanceof HubError &&
        error.data.code === 'akb_document_contract_unavailable');
    assert.equal(observedUrl,
      '/api/content/v1/workspaces/source-workspace/documents?kind=knowledge&query=decision&limit=10&afterId=knowledge-4');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('AKB context transport distinguishes invalid requests and unavailable success contracts', async () => {
  // Given
  let status = 422;
  const server = createServer((_request, response) => {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Fixture did not listen');
  const client = new AkbClient(connection(`http://127.0.0.1:${address.port}/`));
  const selection = { references: [{ kind: 'page' as const, id: 'page-one', revision: 7 }],
    maxBytes: 65_536 };
  try {
    // When / Then
    await assert.rejects(client.readContext(selection), (error: unknown) => error instanceof HubError &&
      error.data.code === 'akb_context_invalid');
    status = 200;
    await assert.rejects(client.readContext(selection), (error: unknown) => error instanceof HubError &&
      error.data.code === 'akb_context_contract_unavailable');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('AKB whole-operation deadline includes a stalled authenticated JSON body', { timeout: 20_000 }, async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Fixture did not listen');
  const cleanup = setTimeout(() => server.closeAllConnections(), 12_000);
  try {
    const client = new AkbClient(akbConnectionSchema.parse({ installationId: 'source', label: 'AKB',
      origin: `http://127.0.0.1:${address.port}/`, authorization: 'Bearer synthetic-private-value',
      workspaceId: 'source-workspace', allowedPageIds: ['page'], workHubWorkspaceId: 'workspace-default',
      allowedProjectIds: ['project-default'] }));
    await assert.rejects(client.readPage('page'), (error: unknown) => error instanceof HubError && error.data.code === 'akb_timeout');
  } finally {
    clearTimeout(cleanup);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
