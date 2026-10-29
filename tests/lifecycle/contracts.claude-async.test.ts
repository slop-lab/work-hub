import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeRunError, type ClaudeRunObserver, type ClaudeSdkDriver } from '../../application/connectors/claude/driver.ts';
import { ClaudeCodeRuntimeConnector } from '../../application/connectors/claude/runtime.ts';
import { ConnectorLedger } from '../../application/connectors/ledger.ts';
import type { ActionContext, AttemptStart } from '../../application/contracts/index.ts';
import { digest } from '../../application/persistence/codec.ts';

const connection = { installationId: 'claude-async', label: 'Claude async fixture', directory: '/fixture' };
const nativeSession = { installationId: connection.installationId, providerScope: connection.directory,
  kind: 'agent-session', id: 'native-session' };
const target = { hubSessionId: 'logical', hubAttemptId: 'attempt', bindingGeneration: 1,
  controlGrantRef: 'claude:logical', nativeSession };
const input: AttemptStart = { target, workAreas: [], input: { id: 'snapshot', digest: digest('snapshot'), taskId: 'task',
  taskRevision: 1, profileId: 'profile', profileRevision: 1, instruction: 'Do actual work', selectedReferenceIds: [],
  selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [], assembledAt: new Date(0).toISOString() } };
const context = (operationId: string): ActionContext => ({ workspaceId: 'hub', installationId: connection.installationId,
  correlationId: operationId, commandId: operationId, operationId, inputDigest: digest(operationId),
  authorizedGrantRefs: ['claude:logical'] });

function fixture(run: ClaudeSdkDriver['run']) {
  const ledger = new ConnectorLedger(':memory:');
  const driver: ClaudeSdkDriver = {
    async discover() { return { version: '0.3.311', sessions: [{ sessionId: nativeSession.id, cwd: connection.directory }] }; },
    async getSession() { return { sessionId: nativeSession.id, cwd: connection.directory }; },
    run,
  };
  const connector = new ClaudeCodeRuntimeConnector(ledger, connection, driver);
  const open = () => connector.openSession(context('open'), { hubSessionId: target.hubSessionId, mode: 'attach', nativeSession,
    sessionLaunchOwner: 'external', requestedControl: 'control', configuration: { model: 'claude-sonnet-4-5' },
    route: { kind: 'external', route: { id: 'configured', ownerInstallationId: connection.installationId, kind: 'sdk' } } });
  return { connector, ledger, open };
}

test('accepted Claude input releases the serial operation before the SDK turn completes', async () => {
  type RunInput = Parameters<ClaudeSdkDriver['run']>[0];
  let finish: ((value: Awaited<ReturnType<ClaudeSdkDriver['run']>>) => void) | undefined;
  let entered: (() => void) | undefined;
  let activeInputId: RunInput['inputId'] | undefined;
  const active = new Promise<Awaited<ReturnType<ClaudeSdkDriver['run']>>>((resolve) => { finish = resolve; });
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const item = fixture((request: RunInput, observer?: ClaudeRunObserver) => {
    activeInputId = request.inputId;
    observer?.accepted({ sessionId: request.sessionId, inputId: request.inputId });
    entered?.();
    return active;
  });
  let start: ReturnType<typeof item.connector.startAttempt> | undefined;
  try {
    await item.open();
    start = item.connector.startAttempt(context('start'), input);
    await running;
    let nextOperationStarted = false;
    const serial = start.then(async (receipt) => {
      nextOperationStarted = true;
      await item.connector.inspectSession(context('inspect'), target);
      return receipt;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(nextOperationStarted, true);
    assert.ok(finish);
    assert.ok(activeInputId);
    const accepted = await start;
    assert.equal(accepted.status, 'confirmed');
    if (accepted.status === 'confirmed') {
      assert.equal(accepted.result.nativeInputRef?.id, activeInputId);
      assert.equal(accepted.result.nativeExecutionRef?.id, activeInputId);
    }
    finish({ sessionId: nativeSession.id, inputId: activeInputId,
      messages: [{ kind: 'result', id: 'result-async', outcome: 'completed', summary: 'done', observedAt: new Date(4).toISOString() }] });
    assert.equal((await serial).status, 'confirmed');
    await item.connector.close();
    const events = [];
    for await (const event of item.connector.subscribe(context('events'), { target })) events.push(event);
    assert.deepEqual(events.map((event) => event.payload.type), ['result.submitted']);
  } finally {
    if (finish && activeInputId) finish({ sessionId: nativeSession.id, inputId: activeInputId, messages: [] });
    if (start) await Promise.allSettled([start]);
    item.ledger.close();
  }
});

test('accepted Claude stream failure drains and retains observed messages without an unhandled rejection', async () => {
  let fail: (() => void) | undefined;
  const item = fixture((request, observer) => {
    observer?.accepted({ sessionId: request.sessionId, inputId: request.inputId });
    return new Promise((_, reject) => {
      fail = () => reject(new ClaudeRunError(request.sessionId, request.inputId, [
        { kind: 'assistant', id: 'assistant-partial', text: 'retained', observedAt: new Date(2).toISOString() },
        { kind: 'result', id: 'result-partial', outcome: 'failed', summary: 'stream failed', observedAt: new Date(3).toISOString() },
      ], new Error('stream failed')));
    });
  });
  try {
    await item.open();
    assert.equal((await item.connector.startAttempt(context('start'), input)).status, 'confirmed');
    assert.ok(fail);
    fail();
    await item.connector.close();
    assert.equal((await item.connector.readOutput(context('output'), { target, limit: 10 })).items[0]?.text, 'retained');
    const events = [];
    for await (const event of item.connector.subscribe(context('events'), { target })) events.push(event);
    assert.deepEqual(events.map((event) => event.payload.type), ['result.submitted']);
  } finally { item.ledger.close(); }
});

test('Claude identity mismatch before acceptance settles unknown instead of leaving delivery pending', async () => {
  const item = fixture((request) => Promise.reject(new ClaudeRunError('different-session', request.inputId, [],
    new Error('identity mismatch'))));
  try {
    await item.open();
    const receipt = await item.connector.startAttempt(context('start'), input);
    assert.equal(receipt.status, 'unknown');
    if (receipt.status === 'unknown') assert.equal(receipt.error.code, 'claude_resume_identity_mismatch');
    await item.connector.close();
  } finally { item.ledger.close(); }
});

test('Claude resolved identity mismatch before acceptance settles unknown instead of hanging', async () => {
  const item = fixture((request) => Promise.resolve({ sessionId: 'different-session', inputId: request.inputId,
    messages: [] }));
  try {
    await item.open();
    const receipt = await item.connector.startAttempt(context('start'), input);
    assert.equal(receipt.status, 'unknown');
    if (receipt.status === 'unknown') assert.equal(receipt.error.code, 'claude_resume_identity_mismatch');
    await item.connector.close();
  } finally { item.ledger.close(); }
});
