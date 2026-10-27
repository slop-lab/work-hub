import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { AkbClient, akbConnectionSchema } from '../application/connectors/akb/index.ts';
import { HubError } from '../application/domain/errors.ts';

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
