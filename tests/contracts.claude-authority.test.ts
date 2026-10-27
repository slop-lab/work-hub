import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorLedger } from '../application/connectors/ledger.ts';
import { parseClaudeTurnFrame, type ClaudeSdkDriver } from '../application/connectors/claude/driver.ts';
import { ClaudeCodeRuntimeConnector } from '../application/connectors/claude/runtime.ts';
import { digest } from '../application/persistence/codec.ts';
import type { ActionContext, AttemptStart, WorkArea } from '../application/contracts/index.ts';

const inputId = '11111111-1111-4111-8111-111111111111';

test('result ends affiliation so a queued native turn cannot contribute text or results', () => {
  const assistant = parseClaudeTurnFrame({ type: 'assistant', session_id: 'native', parent_tool_use_id: null,
    uuid: 'owned-assistant', user_message_uuid: inputId, message: { content: [{ type: 'text', text: 'owned' }] } }, inputId, false);
  const result = parseClaudeTurnFrame({ type: 'result', session_id: 'native', uuid: 'owned-result',
    subtype: 'success', result: 'owned result' }, inputId, assistant.affiliated);
  const queuedText = parseClaudeTurnFrame({ type: 'assistant', session_id: 'native', parent_tool_use_id: null,
    uuid: 'queued-assistant', message: { content: [{ type: 'text', text: 'queued' }] } }, inputId, result.affiliated);
  const queuedResult = parseClaudeTurnFrame({ type: 'result', session_id: 'native', uuid: 'queued-result',
    subtype: 'success', result: 'queued result' }, inputId, queuedText.affiliated);
  assert.equal(result.message?.kind, 'result');
  assert.equal(result.affiliated, false);
  assert.equal(queuedText.message, undefined);
  assert.equal(queuedResult.message, undefined);
});

test('explicitly different user message UUID clears prior affiliation', () => {
  const frame = parseClaudeTurnFrame({ type: 'assistant', session_id: 'native', parent_tool_use_id: null,
    uuid: 'other-assistant', user_message_uuid: '22222222-2222-4222-8222-222222222222',
    message: { content: [{ type: 'text', text: 'other turn' }] } }, inputId, true);
  assert.equal(frame.affiliated, false);
  assert.equal(frame.message, undefined);
});

const allowedArea: WorkArea = { key: 'workspace-root', path: '/fixture', pathNamespace: 'guest',
  requestedAccess: 'read', preparation: 'preserve_existing' };

function authorityFixture() {
  let runCalls = 0;
  const connection = { installationId: 'claude-authority', label: 'Claude authority', directory: '/fixture',
    environment: { executionInstallationId: 'dim', hostId: 'host', workspaceId: 'workspace', incarnation: 'incarnation' } };
  const driver: ClaudeSdkDriver = {
    async discover() { return { version: '0.3.311', sessions: [{ sessionId: 'native', cwd: '/fixture' }] }; },
    async getSession() { return { sessionId: 'native', cwd: '/fixture' }; },
    async run(input) { runCalls += 1; return { sessionId: 'native', inputId: input.inputId, messages: [] }; },
  };
  const ledger = new ConnectorLedger(':memory:');
  const connector = new ClaudeCodeRuntimeConnector(ledger, connection, driver);
  const nativeSession = { installationId: connection.installationId, providerScope: connection.directory,
    kind: 'agent-session', id: 'native' };
  const route = { id: 'route', ownerInstallationId: 'dim', kind: 'workspace' };
  const context = (operationId: string): ActionContext => ({ workspaceId: 'hub', installationId: connection.installationId,
    correlationId: operationId, commandId: operationId, operationId, inputDigest: digest(operationId),
    authorizedGrantRefs: ['environment-grant', 'claude:logical'] });
  const open = () => connector.openSession(context('open'), { hubSessionId: 'logical', mode: 'attach' as const,
    nativeSession, sessionLaunchOwner: 'external' as const, requestedControl: 'control' as const,
    configuration: { model: 'claude-sonnet-4-5' }, route: { kind: 'environment' as const, route,
      attachment: { hubBindingId: 'binding', hubBindingGeneration: 1,
        attachmentRef: { installationId: 'dim', providerScope: 'host', kind: 'attachment', id: 'attachment' },
        identity: { assurance: 'immutable' as const, native: { installationId: 'dim', providerScope: 'host',
          kind: 'workspace', id: 'workspace', incarnation: 'incarnation' } }, origin: 'registered_existing' as const,
        routes: [route], useGrant: { id: 'environment-grant', allowedWorkAreas: [allowedArea],
          runtimeServiceLaunch: false, enforcement: 'enforced' as const, exclusivity: 'hub_only' as const, limitations: [] } } } });
  const target = { hubSessionId: 'logical', hubAttemptId: 'attempt', bindingGeneration: 1,
    controlGrantRef: 'claude:logical', nativeSession };
  const start = (area: WorkArea): Promise<unknown> => connector.startAttempt(context(`start:${area.key}:${area.pathNamespace}:${area.requestedAccess}`), {
    target, workAreas: [area], input: { id: 'snapshot', digest: digest('snapshot'), taskId: 'task', taskRevision: 1,
      profileId: 'profile', profileRevision: 1, instruction: 'work', selectedReferenceIds: [], selectedResponseIds: [],
      contextItems: [], authorizedEffectKinds: [], assembledAt: new Date(0).toISOString() } } satisfies AttemptStart);
  return { ledger, open, start, runCalls: () => runCalls };
}

for (const [label, area] of [
  ['write access', { ...allowedArea, requestedAccess: 'write' as const }],
  ['work-area key', { ...allowedArea, key: 'other-root' }],
  ['path namespace', { ...allowedArea, pathNamespace: 'host' }],
  ['path', { ...allowedArea, path: '/outside' }],
] as const) test(`environment grant rejects mismatched ${label} before the SDK driver`, async () => {
  const item = authorityFixture();
  try {
    await item.open();
    await assert.rejects(item.start(area), /work area|grant/i);
    assert.equal(item.runCalls(), 0);
  } finally { item.ledger.close(); }
});
