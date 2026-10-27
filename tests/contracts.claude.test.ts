import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorLedger } from '../application/connectors/ledger.ts';
import { buildClaudeChildEnvironment, denyClaudePermission, installedClaudeSdkVersion, parseClaudeTurnFrame,
  type ClaudeSdkDriver } from '../application/connectors/claude/driver.ts';
import { ClaudeCodeRuntimeConnector } from '../application/connectors/claude/runtime.ts';
import { ConnectorRegistry } from '../application/orchestration/connectors.ts';
import { digest } from '../application/persistence/codec.ts';
import type { ActionContext, AttemptStart } from '../application/contracts/index.ts';

const connection = { installationId: 'claude-test', label: 'Claude fixture', directory: '/fixture' };
const context = (operationId: string): ActionContext => ({ workspaceId: 'hub', installationId: connection.installationId,
  correlationId: operationId, commandId: operationId, operationId, inputDigest: digest(operationId),
  authorizedGrantRefs: ['claude:logical'] });

function fixture() {
  const calls = { discover: 0, run: 0 };
  const driver: ClaudeSdkDriver = {
    async discover() {
      calls.discover += 1;
      return { version: '2.1.311', sessions: [{ sessionId: 'native-session', summary: 'Existing work',
        cwd: connection.directory, createdAt: new Date(0).toISOString(), lastModified: new Date(1).toISOString() }] };
    },
    async getSession(sessionId) {
      return sessionId === 'native-session' ? { sessionId, summary: 'Existing work', cwd: connection.directory,
        createdAt: new Date(0).toISOString(), lastModified: new Date(1).toISOString() } : undefined;
    },
    async run(input) {
      calls.run += 1;
      return { sessionId: 'native-session', inputId: input.inputId, messages: [{ kind: 'assistant', id: 'assistant-1', text: 'Actual result',
        observedAt: new Date(2).toISOString() }, { kind: 'result', id: 'result-1', outcome: 'completed',
        summary: 'Actual result', observedAt: new Date(3).toISOString() }] };
    },
  };
  const ledger = new ConnectorLedger(':memory:');
  const connector = new ClaudeCodeRuntimeConnector(ledger, connection, driver);
  const nativeSession = { installationId: connection.installationId, providerScope: connection.directory,
    kind: 'agent-session', id: 'native-session' };
  const open = () => connector.openSession(context('open'), { hubSessionId: 'logical', mode: 'attach', nativeSession,
    sessionLaunchOwner: 'external', requestedControl: 'control', configuration: { model: 'claude-sonnet-4-5' },
    route: { kind: 'external', route: { id: 'configured', ownerInstallationId: connection.installationId, kind: 'sdk' } } });
  const target = { hubSessionId: 'logical', hubAttemptId: 'attempt', bindingGeneration: 1,
    controlGrantRef: 'claude:logical', nativeSession };
  const input: AttemptStart = { target, workAreas: [], input: { id: 'snapshot', digest: digest('snapshot'), taskId: 'task',
    taskRevision: 1, profileId: 'profile', profileRevision: 1, instruction: 'Do actual work', selectedReferenceIds: [],
    selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [], assembledAt: new Date(0).toISOString() } };
  return { calls, connector, driver, ledger, nativeSession, open, target, input };
}

test('safe discovery inventories existing native sessions without starting a query', async () => {
  const item = fixture();
  try {
    const discovery = await item.connector.discover(context('discover'));
    assert.equal(discovery.runtimeKind, 'claude-code');
    assert.equal(discovery.sessions[0]?.nativeRef.id, 'native-session');
    assert.equal(item.calls.run, 0);
  } finally { item.ledger.close(); }
});

test('probe is not ready when no attachable session exists and does not claim authentication', async () => {
  const item = fixture();
  try {
    const connector = new ClaudeCodeRuntimeConnector(item.ledger, connection, { ...item.driver,
      async discover() { return { version: '2.1.311', sessions: [] }; } });
    const observation = await connector.probe(context('probe'), { kind: 'external',
      route: { id: 'configured', ownerInstallationId: connection.installationId, kind: 'sdk' } });
    assert.equal(observation.value.ready, false);
    assert.match(observation.limitations[0] ?? '', /Authentication is verified only/);
  } finally { item.ledger.close(); }
});

test('attach attests the exact native session without sending an initial prompt', async () => {
  const item = fixture();
  try {
    const receipt = await item.open();
    assert.equal(receipt.status, 'confirmed');
    assert.equal(item.calls.run, 0);
  } finally { item.ledger.close(); }
});

test('attached session without Hub-owned work reports unknown rather than idle', async () => {
  const item = fixture();
  try {
    await item.open();
    const observation = await item.connector.inspectSession(context('inspect'), item.target);
    assert.equal(observation.value.execution.phase, 'unknown');
  } finally { item.ledger.close(); }
});

test('empty native session creation is explicitly unsupported', async () => {
  const item = fixture();
  try {
    await assert.rejects(item.connector.openSession(context('create'), { hubSessionId: 'logical', mode: 'create',
      sessionLaunchOwner: 'runtime_connector', requestedControl: 'control', configuration: { model: 'claude-sonnet-4-5' },
      route: { kind: 'external', route: { id: 'configured', ownerInstallationId: connection.installationId, kind: 'sdk' } } }), /empty native session/);
    assert.equal(item.calls.run, 0);
  } finally { item.ledger.close(); }
});

test('unknown input delivery is durable and never resent after restart', async () => {
  const item = fixture();
  try {
    await item.open();
    const failing: ClaudeSdkDriver = { discover: item.driver.discover, getSession: item.driver.getSession,
      async run() { item.calls.run += 1; throw new Error('transport lost'); } };
    const first = new ClaudeCodeRuntimeConnector(item.ledger, connection, failing);
    assert.equal((await first.startAttempt(context('start'), item.input)).status, 'unknown');
    const restarted = new ClaudeCodeRuntimeConnector(item.ledger, connection, item.driver);
    assert.equal((await restarted.startAttempt(context('start'), item.input)).status, 'unknown');
    assert.equal(item.calls.run, 1);
  } finally { item.ledger.close(); }
});

test('close rejects new input and drains an active SDK turn without aborting it', async () => {
  const item = fixture();
  let finish: ((value: Awaited<ReturnType<ClaudeSdkDriver['run']>>) => void) | undefined;
  let activeInputId: Parameters<ClaudeSdkDriver['run']>[0]['inputId'] | undefined;
  const pending = new Promise<Awaited<ReturnType<ClaudeSdkDriver['run']>>>((resolve) => { finish = resolve; });
  const connector = new ClaudeCodeRuntimeConnector(item.ledger, connection, { ...item.driver, run(input) {
    activeInputId = input.inputId;
    return pending;
  } });
  try {
    await connector.openSession(context('open'), { hubSessionId: 'logical', mode: 'attach', nativeSession: item.nativeSession,
      sessionLaunchOwner: 'external', requestedControl: 'control', configuration: { model: 'claude-sonnet-4-5' },
      route: { kind: 'external', route: { id: 'configured', ownerInstallationId: connection.installationId, kind: 'sdk' } } });
    const active = connector.startAttempt(context('start'), item.input);
    let drained = false;
    const closing = connector.close().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    await assert.rejects(connector.sendInstruction(context('late'), { target: item.target, text: 'late',
      referenceIds: [], mode: 'runtime_queued' }), /closing/);
    assert.ok(finish);
    assert.ok(activeInputId);
    finish({ sessionId: item.nativeSession.id, inputId: activeInputId,
      messages: [{ kind: 'result', id: 'result-close', outcome: 'completed', summary: 'done', observedAt: new Date(4).toISOString() }] });
    assert.equal((await active).status, 'confirmed');
    await closing;
    assert.equal(drained, true);
  } finally { item.ledger.close(); }
});

test('child environment excludes unrelated runtime and master secrets', () => {
  const child = buildClaudeChildEnvironment({ PATH: '/bin', HOME: '/home/test', ANTHROPIC_API_KEY: 'allowed',
    OPENCODE_AUTHORIZATION: 'forbidden', DIM_MASTER_SECRET: 'forbidden', MASTER_SECRET: 'forbidden' });
  assert.deepEqual(child, { PATH: '/bin', HOME: '/home/test', ANTHROPIC_API_KEY: 'allowed' });
});

test('native permission callback denies rather than auto-approving a tool request', async () => {
  const result = await denyClaudePermission('Bash', { command: 'git status' }, {
    signal: AbortSignal.timeout(1000), toolUseID: 'tool-use', requestId: 'request',
  });
  assert.equal(result?.behavior, 'deny');
});

test('discovery version comes from installed Agent SDK package metadata', async () => {
  assert.equal(await installedClaudeSdkVersion(), '0.3.311');
});

test('native result is observable but remains distinct from human task completion', async () => {
  const item = fixture();
  try {
    await item.open();
    assert.equal((await item.connector.startAttempt(context('start'), item.input)).status, 'confirmed');
    const events = [];
    for await (const event of item.connector.subscribe?.(context('events'), { target: item.target }) ?? []) events.push(event);
    assert.deepEqual(events.map((event) => event.payload.type), ['result.submitted']);
  } finally { item.ledger.close(); }
});

test('replacement attempt cannot inherit prior result ownership', async () => {
  const item = fixture();
  try {
    await item.open();
    await item.connector.startAttempt(context('start-one'), item.input);
    const secondTarget = { ...item.target, hubAttemptId: 'attempt-2' };
    await item.connector.startAttempt(context('start-two'), { ...item.input, target: secondTarget,
      input: { ...item.input.input, id: 'snapshot-2', taskId: 'task-2', digest: digest('snapshot-2') } });
    const observation = await item.connector.inspectSession(context('inspect'), secondTarget);
    assert.equal(observation.value.execution.hubAttemptId, 'attempt-2');
    const events = [];
    for await (const event of item.connector.subscribe(context('events'), { target: secondTarget })) events.push(event);
    assert.deepEqual(events.map((event) => event.payload.type === 'result.submitted' ? event.payload.attemptId : ''),
      ['attempt', 'attempt-2']);
  } finally { item.ledger.close(); }
});

test('SDK ancestry excludes subagent text and accepts only exact main-thread input ancestry', () => {
  const inputId = '11111111-1111-4111-8111-111111111111';
  const subagent = parseClaudeTurnFrame({ type: 'assistant', session_id: 'native-session', uuid: 'subagent',
    parent_tool_use_id: 'tool-1', user_message_uuid: inputId,
    message: { content: [{ type: 'text', text: 'private subagent detail' }] } }, inputId, false);
  const unrelated = parseClaudeTurnFrame({ type: 'assistant', session_id: 'native-session', uuid: 'unrelated',
    parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'unrelated main text' }] } }, inputId, subagent.affiliated);
  const related = parseClaudeTurnFrame({ type: 'assistant', session_id: 'native-session', uuid: 'related',
    parent_tool_use_id: null, user_message_uuids: [inputId],
    message: { content: [{ type: 'text', text: 'related result' }] } }, inputId, unrelated.affiliated);
  const unrelatedResult = parseClaudeTurnFrame({ type: 'result', session_id: 'native-session', uuid: 'result-unrelated',
    subtype: 'success', result: 'must not escape' }, inputId, false);
  const echoedResult = parseClaudeTurnFrame({ type: 'result', session_id: 'native-session', uuid: 'result-echoed',
    subtype: 'success', user_message_uuid: inputId, result: 'accepted' }, inputId, false);
  const affiliatedResult = parseClaudeTurnFrame({ type: 'result', session_id: 'native-session', uuid: 'result-affiliated',
    subtype: 'success', result: 'accepted after assistant' }, inputId, related.affiliated);
  assert.equal(subagent.message, undefined);
  assert.equal(unrelated.message, undefined);
  assert.equal(related.message?.kind, 'assistant');
  assert.equal(unrelatedResult.message, undefined);
  assert.equal(echoedResult.message?.kind, 'result');
  assert.equal(affiliatedResult.message?.kind, 'result');
});

test('registry boundary accepts Claude attach input output result and detach receipts', async () => {
  const item = fixture();
  try {
    const registry = new ConnectorRegistry({ execution: {}, runtime: { [connection.installationId]: item.connector } });
    assert.equal(registry.available('agent_runtime', connection.installationId), true);
    const connector = registry.runtime(connection.installationId);
    assert.equal((await connector.openSession(context('open'), { hubSessionId: 'logical', mode: 'attach',
      nativeSession: item.nativeSession, sessionLaunchOwner: 'external', requestedControl: 'control',
      configuration: { model: 'claude-sonnet-4-5' }, route: { kind: 'external',
        route: { id: 'configured', ownerInstallationId: connection.installationId, kind: 'sdk' } } })).status, 'confirmed');
    const receipt = await connector.startAttempt(context('start'), item.input);
    assert.equal(receipt.status, 'confirmed');
    if (receipt.status === 'confirmed') assert.equal(receipt.evidence.effect, 'attempt.input_received');
    const target = { hubSessionId: item.target.hubSessionId, nativeSession: item.target.nativeSession,
      bindingGeneration: item.target.bindingGeneration, controlGrantRef: item.target.controlGrantRef };
    assert.equal((await connector.readOutput(context('output'), { target, limit: 10 })).items[0]?.text, 'Actual result');
    const events = [];
    for await (const event of connector.subscribe?.(context('events'), { target }) ?? []) events.push(event);
    assert.deepEqual(events.map((event) => event.payload.type), ['result.submitted']);
    assert.equal((await connector.detachSession(context('detach'), target)).status, 'confirmed');
  } finally { item.ledger.close(); }
});
