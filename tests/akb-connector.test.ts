import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { AkbClient, AkbContextService, akbConnectionSchema } from '../application/connectors/akb/index.ts';
import { HubError } from '../application/domain/errors.ts';
import { externalContextRoutes } from '../application/api/external-context.ts';
import { Hono } from 'hono';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('fixture did not listen');
  return `http://127.0.0.1:${(address satisfies AddressInfo).port}/`;
}

const page = {
  id: 'page-one', workspaceId: 'akb-workspace', spaceId: 'space-one', parentPageId: null,
  title: 'Runbook', revision: 7, lifecycle: 'active',
  document: { version: 1, blocks: [{ id: 'intro', type: 'paragraph', text: 'Deploy safely.', children: [] }] },
  createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
} as const;

test('AKB client sends backend bearer auth and projects only configured active scope', async () => {
  // Given
  const origin = await fixture((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer private-token');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ pages: [page, { ...page, id: 'other', spaceId: 'space-other' }, { ...page, id: 'old', lifecycle: 'archived' }] }));
  });
  const client = new AkbClient(akbConnectionSchema.parse({ installationId: 'akb-one', label: 'AKB', origin,
    authorization: 'Bearer private-token', workspaceId: 'akb-workspace', allowedSpaceIds: ['space-one'],
    workHubWorkspaceId: 'workspace-default', allowedProjectIds: ['project-default'] }));

  // When
  const pages = await client.listPages(null);

  // Then
  assert.deepEqual(pages.map((item) => item.id), ['page-one']);
  assert.equal(JSON.stringify(pages).includes('private-token'), false);
  assert.equal(JSON.stringify(pages).includes(origin), false);
});

test('AKB client fails closed when a page is revoked, archived, or outside configured scope', async () => {
  // Given
  let responseKind: 'missing' | 'archived' | 'outside' = 'missing';
  const origin = await fixture((_request, response) => {
    if (responseKind === 'missing') { response.statusCode = 404; response.end('{}'); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ page: responseKind === 'archived' ? { ...page, lifecycle: 'archived' } : { ...page, spaceId: 'space-other' }, projection: {} }));
  });
  const client = new AkbClient(akbConnectionSchema.parse({ installationId: 'akb-one', label: 'AKB', origin,
    authorization: 'Bearer private-token', workspaceId: 'akb-workspace', allowedSpaceIds: ['space-one'],
    workHubWorkspaceId: 'workspace-default', allowedProjectIds: ['project-default'] }));

  // When / Then
  await assert.rejects(client.readPage('page-one'), (error) => error instanceof HubError && error.data.code === 'akb_page_unavailable');
  responseKind = 'archived';
  await assert.rejects(client.readPage('page-one'), (error) => error instanceof HubError && error.data.code === 'akb_page_archived');
  responseKind = 'outside';
  await assert.rejects(client.readPage('page-one'), (error) => error instanceof HubError && error.data.code === 'akb_page_outside_scope');
});

test('AKB capture re-reads the source and rejects a stale selected revision', async () => {
  // Given
  const origin = await fixture((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ page, projection: {} }));
  });
  const client = new AkbClient(akbConnectionSchema.parse({ installationId: 'akb-one', label: 'AKB', origin,
    authorization: 'Bearer private-token', workspaceId: 'akb-workspace', allowedPageIds: ['page-one'],
    workHubWorkspaceId: 'workspace-default', allowedProjectIds: ['project-default'] }));
  let captured = false;
  const service = new AkbContextService({ 'akb-one': client }, (_actor, input) => {
    if (!('retainedText' in input)) return undefined;
    captured = true;
    throw new TypeError('unexpected capture');
  },
    () => 'project-default');

  // When / Then
  await assert.rejects(service.capture({ id: 'user-member', workspaceId: 'workspace-default', role: 'member',
    projectIds: ['project-default'], profileIds: [], bindingIds: [] }, { taskId: 'task-one', installationId: 'akb-one',
    pageId: 'page-one', revision: 6, commandId: 'capture-stale' }),
    (error) => error instanceof HubError && error.data.code === 'akb_revision_changed');
  assert.equal(captured, false);
});

test('external context HTTP lists safe metadata and captures the selected immutable revision', async () => {
  // Given
  const origin = await fixture((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ page, projection: {} }));
  });
  const client = new AkbClient(akbConnectionSchema.parse({ installationId: 'akb-one', label: 'AKB', origin,
    authorization: 'Bearer private-token', workspaceId: 'akb-workspace', allowedPageIds: ['page-one'],
    workHubWorkspaceId: 'workspace-default', allowedProjectIds: ['project-default'] }));
  let capturedText = '';
  const service = new AkbContextService({ 'akb-one': client }, (_actor, input) => {
    if (!('retainedText' in input)) return undefined;
    capturedText = input.retainedText;
    assert.equal(input.commandId, 'capture-page-one');
    return { kind: 'reference', id: 'reference-one', revision: 1 };
  }, () => 'project-default');
  const app = new Hono();
  app.route('/api/v1', externalContextRoutes({ service, actor: () => ({ id: 'user-member',
    workspaceId: 'workspace-default', role: 'member', projectIds: ['project-default'], profileIds: [], bindingIds: [] }) }));

  // When
  const connections = await app.request('/api/v1/external-context/akb?projectId=project-default');
  const capture = await app.request('/api/v1/tasks/task-one/external-context/akb', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'capture-page-one', installationId: 'akb-one', pageId: 'page-one', revision: 7 }) });

  // Then
  assert.deepEqual(await connections.json(), { connections: [{ installationId: 'akb-one', label: 'AKB' }] });
  assert.equal(capture.status, 201);
  assert.deepEqual(await capture.json(), { reference: { kind: 'reference', id: 'reference-one', revision: 1 } });
  assert.equal(capturedText, 'Deploy safely.');
});

test('AKB service rejects an unscoped task before making a source request', async () => {
  // Given
  let requests = 0;
  const origin = await fixture((_request, response) => { requests += 1; response.end('{}'); });
  const client = new AkbClient(akbConnectionSchema.parse({ installationId: 'akb-one', label: 'AKB', origin,
    authorization: 'Bearer private-token', workspaceId: 'akb-workspace', allowedPageIds: ['page-one'],
    workHubWorkspaceId: 'workspace-default', allowedProjectIds: ['project-default'] }));
  const actor = { id: 'user-member', workspaceId: 'workspace-default', role: 'member' as const,
    projectIds: ['project-other'], profileIds: [], bindingIds: [] };
  const service = new AkbContextService({ 'akb-one': client }, (_actor, input) => {
    if (!('retainedText' in input)) return undefined;
    throw new TypeError('unexpected capture');
  },
    () => 'project-other');

  // When / Then
  assert.deepEqual(service.connections(actor, 'project-other'), []);
  await assert.rejects(service.capture(actor, { taskId: 'task-one', installationId: 'akb-one', pageId: 'page-one',
    revision: 7, commandId: 'capture-unscoped' }),
    (error) => error instanceof HubError && error.data.code === 'akb_connection_unavailable');
  assert.equal(requests, 0);
});

test('AKB capture replay returns the immutable receipt without reading changed or revoked source state', async () => {
  // Given
  let requests = 0;
  let available = true;
  const origin = await fixture((_request, response) => {
    requests += 1;
    if (!available) { response.statusCode = 404; response.end('{}'); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ page, projection: {} }));
  });
  const client = new AkbClient(akbConnectionSchema.parse({ installationId: 'akb-one', label: 'AKB', origin,
    authorization: 'Bearer private-token', workspaceId: 'akb-workspace', allowedPageIds: ['page-one', 'page-other'],
    workHubWorkspaceId: 'workspace-default', allowedProjectIds: ['project-default'] }));
  const actor = { id: 'user-member', workspaceId: 'workspace-default', role: 'member' as const,
    projectIds: ['project-default'], profileIds: [], bindingIds: [] };
  let selection: string | undefined;
  let captures = 0;
  const receipt = { kind: 'reference' as const, id: 'reference-one', revision: 1 as const };
  const service = new AkbContextService({ 'akb-one': client }, (_actor, input) => {
    const current = JSON.stringify({ taskId: input.taskId, installationId: Reflect.get(input, 'installationId'),
      pageId: Reflect.get(input, 'pageId'), revision: Reflect.get(input, 'revision') });
    if (Reflect.get(input, 'retainedText') === undefined) {
      if (selection !== undefined && selection !== current) throw new HubError({ code: 'idempotency_key_conflict',
        category: 'conflict', message: 'changed selection', retry: 'never' });
      return selection === undefined ? undefined : receipt;
    }
    selection = current;
    captures += 1;
    return receipt;
  }, () => 'project-default');
  const input = { commandId: 'capture-replay', taskId: 'task-one', installationId: 'akb-one',
    pageId: 'page-one', revision: 7 };
  assert.deepEqual(await service.capture(actor, input), receipt);
  available = false;

  // When
  const replay = await service.capture(actor, input);

  // Then
  assert.deepEqual(replay, receipt);
  assert.equal(requests, 1);
  assert.equal(captures, 1);
  const disconnected = new AkbContextService({}, () => receipt, () => 'project-default');
  assert.deepEqual(await disconnected.capture(actor, input), receipt);
  await assert.rejects(service.capture(actor, { ...input, pageId: 'page-other' }),
    (error) => error instanceof HubError && error.data.code === 'idempotency_key_conflict');
  assert.equal(requests, 1);
});
