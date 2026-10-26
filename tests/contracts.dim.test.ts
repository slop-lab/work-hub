import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ConnectorLedger } from '../application/connectors/ledger.ts';
import { DimExecutionConnector } from '../application/connectors/dim.ts';
import type { ExistingEnvironmentRegistration } from '../application/contracts/index.ts';
import { digest } from '../application/persistence/codec.ts';
import { executionBoundary } from '../application/orchestration/connector-boundary.ts';

async function fixture() {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer scoped-fixture') { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify(req.url === '/v1/resources' ? { cpuCount: '8', memory: '32GiB', pidsLimit: '8192' } : {
      plugins: [{ name: 'external-urls', state: 'ready' }],
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const ledger = new ConnectorLedger(':memory:');
  const connection = { installationId: 'dim-scoped', label: 'Scoped fixture', endpoint: `http://127.0.0.1:${address.port}`,
    token: 'scoped-fixture', hostId: 'host-stable-id', workspaceId: randomUUID(), incarnation: 'incarnation-one',
    displayName: 'Friendly name is not identity', identityExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    runtimeInstallationId: 'native', allowedProjectIds: ['project'], workAreas: [{ key: 'repo-main', path: '/fixture',
      pathNamespace: 'dim-workspace-posix', requestedAccess: 'write' as const, preparation: 'preserve_existing' as const }] };
  const connector = executionBoundary(new DimExecutionConnector(ledger, connection, async () => '/fixture'));
  const ctx = { workspaceId: 'hub', installationId: connection.installationId, correlationId: 'test', commandId: 'test',
    operationId: 'attach', inputDigest: digest('attach'), authorizedGrantRefs: ['dim:registered'] };
  const registration: ExistingEnvironmentRegistration = { id: 'registered', revision: 1, label: connection.displayName,
    executionInstallationId: connection.installationId,
    locator: { hostId: connection.hostId, workspaceId: connection.workspaceId, incarnation: connection.incarnation },
    secretRefs: [], allowedProjectIds: ['project'], allowedWorkAreas: connection.workAreas,
    allowRuntimeServiceLaunch: false, weakIdentityExplicitlyAccepted: false };
  return { connector, ledger, calls, ctx, connection, registration, close: async () => {
    ledger.close(); server.close(); await once(server, 'close');
  } };
}

test('DIM attachment verifies exact scoped identity and never gains lifecycle authority', async () => {
  const f = await fixture();
  try {
    const probe = await f.connector.probeExisting(f.ctx, f.registration);
    assert.equal(probe.value.identity.native.id, f.connection.workspaceId);
    assert.equal(probe.value.identity.native.providerScope, f.connection.hostId);
    const attached = await f.connector.attach(f.ctx, { hubBindingId: 'binding', hubBindingGeneration: 1,
      projectId: 'project', taskId: 'task', sessionId: 'session', target: { kind: 'registered_existing',
        registration: f.registration, expectedIdentity: probe.value.identity },
      workAreas: f.connection.workAreas, requestedAccess: 'write', preparation: 'preserve_existing' });
    assert.ok(attached.status === 'confirmed');
    assert.equal(attached.result.lifecycleGrant, undefined);
    assert.equal((await f.connector.inspectBinding(f.ctx, attached.result)).value.attachmentValid, true);
    const detached = await f.connector.detachAttachment({ ...f.ctx, operationId: 'detach' }, {
      attachmentRef: attached.result.attachmentRef, expectedIdentity: attached.result.identity });
    assert.equal(detached.status, 'confirmed');
    assert.equal(f.calls.every((call) => call === 'GET /v1/resources' || call === 'GET /v1/plugins'), true);
  } finally { await f.close(); }
});

test('expired DIM attestation fails closed before discovery', async () => {
  const f = await fixture();
  try {
    const expired = new DimExecutionConnector(f.ledger, { ...f.connection, identityExpiresAt: new Date(0).toISOString() }, async () => '/fixture');
    await assert.rejects(expired.probeExisting(f.ctx, f.registration), /expired/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('DIM display name cannot substitute for workspace UUID or incarnation', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.connector.probeExisting(f.ctx, { ...f.registration,
      locator: { hostId: f.connection.hostId, workspaceId: f.connection.displayName, incarnation: f.connection.incarnation } }), /identity/);
  } finally { await f.close(); }
});

test('DIM runtime directory mismatch refuses registration', async () => {
  const f = await fixture();
  try {
    const wrong = new DimExecutionConnector(f.ledger, f.connection, async () => '/another-repository');
    await assert.rejects(wrong.probeExisting(f.ctx, f.registration), /working directory/);
  } finally { await f.close(); }
});

test('DIM allocation and release remain explicitly unsupported on scoped connections', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.connector.requestAllocation(f.ctx, { taskId: 'task', sessionId: 'session', attemptId: 'attempt',
      externalProfileRef: 'none', parameters: {}, releasePolicyRef: 'none', workAreas: [], allowedPreparationEffects: [] }), /no allocation/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.connector.describe().extensions?.['release'], false);
  } finally { await f.close(); }
});

test('DIM attachment refuses an absent selected use grant before creating an attachment', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.connector.attach({ ...f.ctx, authorizedGrantRefs: [] }, { hubBindingId: 'binding', hubBindingGeneration: 1,
      projectId: 'project', taskId: 'task', sessionId: 'session', target: { kind: 'registered_existing',
        registration: f.registration, expectedIdentity: { native: { installationId: f.connection.installationId,
          providerScope: f.connection.hostId, kind: 'dim-workspace', id: f.connection.workspaceId, incarnation: f.connection.incarnation }, assurance: 'attested' } },
      workAreas: f.connection.workAreas, requestedAccess: 'write', preparation: 'preserve_existing' }), /use grant is required/);
    assert.equal((await f.connector.lookupOperation(f.ctx, f.ctx.operationId)).kind, 'not_found');
  } finally { await f.close(); }
});
