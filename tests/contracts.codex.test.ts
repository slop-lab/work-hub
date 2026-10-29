import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexRuntimeConnector } from '../application/connectors/codex/runtime.ts';
import { validateConnectorReceipt } from '../application/orchestration/connector-receipt.ts';
import type { EnvironmentAttachment, OpenSessionInput } from '../application/contracts/index.ts';
import { codexContext, codexFixture } from './codex-fixture.ts';

test('Codex discovery exposes safe configured inventory without account secrets', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    const inventory = await fixture.connector.discover(codexContext('discover'));
    assert.equal(inventory.version, '0.164.0');
    assert.equal(inventory.directory, '/fixture');
    assert.deepEqual(inventory.agents, [{ id: 'codex', label: 'Codex CLI' }]);
    assert.deepEqual(inventory.models.map((model) => model.id), ['fixture-model']);
    assert.equal(inventory.sessions[0]?.nativeRef.kind, 'agent-thread');
    assert.equal(JSON.stringify(inventory).includes('apiKey'), false);
  } finally { await fixture.close(); }
});

test('Codex creates threads with approval policy never and does not autoapprove server requests', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    const start = fixture.protocol.calls.find((call) => call.method === 'thread/start');
    assert.deepEqual(start?.params, { cwd: '/fixture', model: 'fixture-model', modelProvider: 'openai',
      ephemeral: false, approvalPolicy: 'never' });
    assert.equal(fixture.connector.describe().capabilities.nativeQuestions.support, 'supported');
    assert.equal(fixture.connector.describe().capabilities.nativeApprovals.support, 'unsupported');
  } finally { await fixture.close(); }
});

test('turn start uses a durable client message id and returns native thread and turn ids', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    const receipt = await fixture.connector.startAttempt(codexContext('start'), fixture.input);
    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.status === 'confirmed' && receipt.result.nativeExecutionRef?.id, '01900000-0000-7000-8000-000000000002');
    const call = fixture.protocol.calls.find((item) => item.method === 'turn/start');
    assert.deepEqual(call?.params, { threadId: fixture.target.nativeSession.id, clientUserMessageId: 'workhub:start',
      input: [{ type: 'text', text: fixture.input.input.instruction, text_elements: [] }] });
  } finally { await fixture.close(); }
});

test('unknown turn delivery is never resent and reconciles only from exact client message id', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    fixture.protocol.persistTurn = false;
    const original = fixture.protocol.request.bind(fixture.protocol);
    let fail = true;
    fixture.protocol.request = async (method, params) => {
      const result = await original(method, params);
      if (method === 'turn/start' && fail) { fail = false; throw new Error('lost response'); }
      return result;
    };
    assert.equal((await fixture.connector.startAttempt(codexContext('start'), fixture.input)).status, 'unknown');
    const restarted = new CodexRuntimeConnector(fixture.ledger, fixture.connection, fixture.protocol);
    assert.equal((await restarted.startAttempt(codexContext('start'), fixture.input)).status, 'unknown');
    assert.equal(fixture.protocol.calls.filter((item) => item.method === 'turn/start').length, 1);
    assert.equal((await restarted.lookupOperation(codexContext('lookup'), 'start')).kind, 'found');
  } finally { await fixture.close(); }
});

test('Codex attachment validates exact directory, provider, model, and native identity without sending input', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    const calls = fixture.protocol.calls.length;
    const receipt = await fixture.connector.openSession(codexContext('attach'), { hubSessionId: 'attached', mode: 'attach',
      nativeSession: fixture.target.nativeSession, sessionLaunchOwner: 'external', requestedControl: 'observe',
      configuration: { agent: 'codex', model: { providerID: 'openai', modelID: 'fixture-model' }, projectId: 'project-default' },
      route: { kind: 'external', route: { id: 'configured', ownerInstallationId: 'codex-test', kind: 'stdio' } } });
    assert.equal(receipt.status, 'confirmed');
    assert.equal(fixture.protocol.calls.slice(calls).some((item) => item.method === 'turn/start'), false);
  } finally { await fixture.close(); }
});

test('Codex interrupt receipt carries request-only evidence accepted by the connector boundary', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(codexContext('start'), fixture.input);
    const context = codexContext('stop');
    const receipt = await fixture.connector.requestStop(context, { target: fixture.target, mode: 'interrupt' });
    assert.equal(validateConnectorReceipt({ context, receipt, operationKind: 'runtime.requestStop' }).status, 'confirmed');
  } finally { await fixture.close(); }
});

test('provider interruption is observed as stopped separately from an accepted interrupt request', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(codexContext('start'), fixture.input);
    const thread = fixture.protocol.threads.get(fixture.target.nativeSession.id) as { readonly turns: readonly Record<string, unknown>[] };
    const turn = thread.turns[0];
    assert.ok(turn);
    fixture.protocol.threads.set(fixture.target.nativeSession.id, { ...thread, status: { type: 'idle' },
      turns: [{ ...turn, status: 'interrupted', completedAt: 4 }] });
    const observation = await fixture.connector.inspectSession(codexContext('inspect-interrupted'), fixture.target);
    assert.equal(observation.value.execution.termination, 'stopped');
    const receipt = await fixture.connector.requestStop(codexContext('stop-after-provider'), { target: fixture.target, mode: 'interrupt' });
    assert.equal(receipt.status === 'confirmed' && receipt.result.effect, 'request_accepted');
  } finally { await fixture.close(); }
});

test('Codex probe is not ready when the scoped app-server has no authenticated account', async () => {
  const fixture = codexFixture();
  try {
    fixture.protocol.authenticated = false;
    const observation = await fixture.connector.probe(codexContext('probe'), {
      kind: 'external', route: { id: 'configured', ownerInstallationId: 'codex-test', kind: 'stdio' },
    });
    assert.equal(observation.value.ready, false);
    assert.deepEqual(observation.value.unmetRequirements, ['Codex authentication is unavailable for this scoped installation.']);
  } finally { await fixture.close(); }
});

test('unbound Codex thread is idle only when the native thread reports exact idle status', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    const thread = fixture.protocol.threads.get(fixture.target.nativeSession.id);
    assert.ok(thread && typeof thread === 'object');
    fixture.protocol.threads.set(fixture.target.nativeSession.id, { ...thread, status: { type: 'active', activeFlags: [] } });
    const observation = await fixture.connector.inspectSession(codexContext('inspect-active'), fixture.target);
    assert.equal(observation.value.execution.phase, 'unknown');
  } finally { await fixture.close(); }
});

test('mapped Codex requires exact environment route and grant before creating a thread', async () => {
  const fixture = codexFixture();
  const mapping = { executionInstallationId: 'dim', hostId: 'host', workspaceId: 'workspace', incarnation: 'incarnation' };
  const connector = new CodexRuntimeConnector(fixture.ledger, { ...fixture.connection, environment: mapping }, fixture.protocol);
  const area = { key: 'repo', path: '/fixture', pathNamespace: 'dim-workspace-posix', requestedAccess: 'write', preparation: 'preserve_existing' } as const;
  const route = { id: 'codex-route', ownerInstallationId: 'dim', kind: 'codex-stdio' };
  const attachment: EnvironmentAttachment = { hubBindingId: 'binding', hubBindingGeneration: 1,
    attachmentRef: { installationId: 'dim', providerScope: 'host', kind: 'attachment', id: 'binding' },
    identity: { native: { installationId: 'dim', providerScope: 'host', kind: 'dim-workspace', id: 'workspace', incarnation: 'incarnation' }, assurance: 'attested' },
    origin: 'registered_existing', routes: [route], useGrant: { id: 'use-grant', allowedWorkAreas: [area], runtimeServiceLaunch: false,
      enforcement: 'advisory', exclusivity: 'hub_only', expiresAt: new Date(Date.now() + 60_000).toISOString(), limitations: [] } };
  const input: OpenSessionInput = { hubSessionId: 'mapped', mode: 'create', sessionLaunchOwner: 'runtime_connector', requestedControl: 'control',
    configuration: { agent: 'codex', model: { providerID: 'openai', modelID: 'fixture-model' }, projectId: 'project-default' },
    route: { kind: 'environment', attachment, route } };
  try {
    await assert.rejects(connector.openSession(codexContext('missing-grant'), input), /grant/);
    await assert.rejects(connector.openSession({ ...codexContext('external'), authorizedGrantRefs: ['use-grant'] }, { ...input,
      route: { kind: 'external', route: { id: 'configured', ownerInstallationId: 'codex-test', kind: 'stdio' } } }), /mapped environment/);
    assert.equal((await connector.openSession({ ...codexContext('mapped-open'), authorizedGrantRefs: ['use-grant'] }, input)).status, 'confirmed');
  } finally { await fixture.close(); }
});
