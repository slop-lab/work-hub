import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorLedger } from '../../application/connectors/ledger.ts';
import { parseClaudeTurnFrame, type ClaudeSdkDriver } from '../../application/connectors/claude/driver.ts';
import { ClaudeCodeRuntimeConnector } from '../../application/connectors/claude/runtime.ts';
import { digest } from '../../application/persistence/codec.ts';
import { renderPrompt } from '../../application/prompts/index.ts';
import type { ActionContext, AttemptStart, RuntimeEvent } from '../../application/contracts/index.ts';

const connection = { installationId: 'claude-lifecycle', label: 'Claude lifecycle', directory: '/fixture' };
const nativeSession = { installationId: connection.installationId, providerScope: connection.directory,
  kind: 'agent-session', id: 'native-session' };
const context = (operationId: string): ActionContext => ({ workspaceId: 'hub', installationId: connection.installationId,
  correlationId: operationId, commandId: operationId, operationId, inputDigest: digest(operationId),
  authorizedGrantRefs: ['claude:logical'] });
const target = { hubSessionId: 'logical', hubAttemptId: 'attempt', bindingGeneration: 1,
  controlGrantRef: 'claude:logical', nativeSession };
const pendingCriterion = { id: 'criterion', taskId: 'task', amendmentId: 'amendment', key: 'native-verification',
  description: 'Native verification passes', requirement: 'required' as const, verification: 'required' as const,
  createdAt: new Date(0).toISOString() };
const renderedPrompt = renderPrompt('task_brief', {
  task: { id: 'task', revision: 1, scopeRevision: 1, title: 'Sanitized task', description: 'Run the fixture.' },
  attemptId: 'attempt', instruction: 'Run the fixture.',
  execution: { profileId: 'profile', profileRevision: 1, runtimeInstallationId: connection.installationId,
    environment: { mode: 'none' } },
  amendments: [{ id: 'amendment', taskId: 'task', revision: 1, authorId: 'user', summary: 'Initial scope',
    criteria: [pendingCriterion], supersedesCriterionIds: [], createdAt: new Date(0).toISOString() }],
  criteria: [pendingCriterion], context: [],
});
const input: AttemptStart = { target, workAreas: [], input: { id: 'snapshot', digest: digest('snapshot'), taskId: 'task',
  taskRevision: 1, scopeRevision: 1, profileId: 'profile', profileRevision: 1, instruction: renderedPrompt.text,
  selectedReferenceIds: [], selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [],
  assembledAt: new Date(0).toISOString(), promptDigest: renderedPrompt.digest } };

async function fixture(driver: ClaudeSdkDriver) {
  const ledger = new ConnectorLedger(':memory:');
  const connector = new ClaudeCodeRuntimeConnector(ledger, connection, driver);
  await connector.openSession(context('open'), { hubSessionId: 'logical', mode: 'attach', nativeSession,
    sessionLaunchOwner: 'external', requestedControl: 'control', configuration: { model: 'claude-sonnet-4-5' },
    route: { kind: 'external', route: { id: 'configured', ownerInstallationId: connection.installationId, kind: 'sdk' } } });
  return { connector, ledger };
}

function driver(run: ClaudeSdkDriver['run']): ClaudeSdkDriver {
  return {
    async discover() { return { version: '0.3.311', sessions: [{ sessionId: nativeSession.id, cwd: connection.directory }] }; },
    async getSession() { return { sessionId: nativeSession.id, cwd: connection.directory }; },
    run,
  };
}

test('task and controlled-continuation templates are delivered byte-for-byte', async () => {
  const prompts: string[] = [];
  const item = await fixture(driver(async (request) => {
    prompts.push(request.prompt);
    return { sessionId: nativeSession.id, inputId: request.inputId, messages: [{ kind: 'result', frame: 'final',
      id: `result-${prompts.length}`, outcome: 'completed', summary: 'complete', observedAt: new Date().toISOString() }] };
  }));
  try {
    await item.connector.startAttempt(context('start'), input);
    const continuation = renderPrompt('answer_continuation', { taskId: 'task', attemptId: 'attempt', requestId: 'request',
      acceptedAnswer: { kind: 'text', text: 'Use the disposable fixture.' }, scopeRevision: 1,
      completedWork: ['Initial analysis retained.'],
      pendingCriteria: [pendingCriterion] });
    await item.connector.sendInstruction(context('continue'), { target, text: continuation.text,
      referenceIds: [], mode: 'runtime_queued' });
    assert.deepEqual(prompts, [renderedPrompt.text, continuation.text]);
  } finally { item.ledger.close(); }
});

test('SDK frames retain exact retry rate tool subagent startup and terminal metadata', () => {
  const checkpoint = parseClaudeTurnFrame({ type: 'assistant', session_id: nativeSession.id,
    uuid: '00000000-0000-4000-8000-000000000000', parent_tool_use_id: null, user_message_uuid: 'input',
    message: { content: [{ type: 'text', text: 'checkpoint' }] } }, 'input', false).messages;
  const retry = parseClaudeTurnFrame({ type: 'system', subtype: 'api_retry', session_id: nativeSession.id,
    uuid: '11111111-1111-4111-8111-111111111111', attempt: 2, max_retries: 4, retry_delay_ms: 500,
    error_status: 529, error: 'overloaded' }, 'input', true).messages;
  const rate = parseClaudeTurnFrame({ type: 'rate_limit_event', session_id: nativeSession.id,
    uuid: '22222222-2222-4222-8222-222222222222', rate_limit_info: { status: 'allowed_warning',
      resetsAt: 1234, rateLimitType: 'five_hour', utilization: 0.9 } }, 'input', true).messages;
  const tool = parseClaudeTurnFrame({ type: 'tool_progress', session_id: nativeSession.id,
    uuid: '33333333-3333-4333-8333-333333333333', tool_use_id: 'tool-1', tool_name: 'Agent',
    parent_tool_use_id: null, elapsed_time_seconds: 3, task_id: 'task-1', subagent_type: 'Explore',
    subagent_retry: { agent_id: 'agent-1', attempt: 2, max_retries: 3, retry_delay_ms: 250,
      error_status: null, error_category: 'connection' } }, 'input', true).messages;
  const started = parseClaudeTurnFrame({ type: 'system', subtype: 'task_started', session_id: nativeSession.id,
    uuid: '44444444-4444-4444-8444-444444444444', task_id: 'task-1', run_id: 'run-1',
    description: 'Inspect lifecycle', subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1,
    task_type: 'local_agent' }, 'input', true).messages;
  const startup = parseClaudeTurnFrame({ type: 'system', subtype: 'init', session_id: nativeSession.id,
    uuid: '55555555-5555-4555-8555-555555555555', model: 'claude-sonnet-4-5', cwd: '/fixture',
    tools: ['Agent'], permissionMode: 'default', capabilities: ['interrupt_receipt_v1'] }, 'input', true).messages;
  const terminal = parseClaudeTurnFrame({ type: 'result', subtype: 'error_during_execution', session_id: nativeSession.id,
    uuid: '66666666-6666-4666-8666-666666666666', is_error: true, result: '', errors: ['cwd missing'],
    startup_failure_reason: 'cwd_unavailable', terminal_reason: 'turn_setup_failed', user_message_uuid: 'input' }, 'input', true).messages;

  assert.equal(checkpoint?.[0]?.kind === 'assistant' ? checkpoint[0].frame : undefined, 'checkpoint');
  assert.deepEqual(retry?.[0], { kind: 'retry', id: '11111111-1111-4111-8111-111111111111', attempt: 2,
    maxRetries: 4, retryDelayMs: 500, errorStatus: 529, error: 'overloaded', observedAt: retry?.[0]?.observedAt });
  assert.equal(rate?.[0]?.kind, 'rate_limit');
  assert.equal(tool?.[0]?.kind, 'tool');
  assert.equal(started?.[0]?.kind, 'subagent');
  assert.equal(started?.[0]?.kind === 'subagent' ? started[0].taskType : undefined, 'local_agent');
  assert.equal(started?.[0]?.kind === 'subagent' ? started[0].isBackgrounded : undefined, true);
  assert.equal(started?.[0]?.kind === 'subagent' ? started[0].spawnDepth : undefined, 1);
  assert.equal(startup?.[0]?.kind, 'startup');
  const terminalResult = terminal?.at(-1);
  assert.equal(terminalResult?.kind, 'result');
  assert.equal(terminalResult?.kind === 'result' ? terminalResult.frame : undefined, 'final');
  assert.equal(terminalResult?.kind === 'result' ? terminalResult.startupFailureReason : undefined, 'cwd_unavailable');
});

test('stale task template digest is rejected before SDK delivery', async () => {
  let runs = 0;
  const item = await fixture(driver(async (request) => {
    runs += 1;
    return { sessionId: nativeSession.id, inputId: request.inputId, messages: [] };
  }));
  try {
    await assert.rejects(item.connector.startAttempt(context('stale'), { ...input,
      input: { ...input.input, promptDigest: digest('different prompt') } }), /prompt digest/);
    assert.equal(runs, 0);
  } finally { item.ledger.close(); }
});

test('bounded incomplete subagent registry prevents parent final completion', async () => {
  const item = await fixture(driver(async (request) => ({ sessionId: nativeSession.id, inputId: request.inputId,
    messages: [{ kind: 'subagent', id: 'task-start', event: 'started', taskId: 'task-1', runId: 'run-1',
      description: 'child', phase: 'running', ambient: false, observedAt: new Date(1).toISOString() },
    { kind: 'result', frame: 'final', id: 'result', outcome: 'completed', summary: 'parent final', observedAt: new Date(2).toISOString() }] })));
  try {
    await item.connector.startAttempt(context('start'), input);
    const observation: Awaited<ReturnType<typeof item.connector.inspectSession>> = await item.connector.inspectSession(context('inspect'), target);
    const events: RuntimeEvent[] = [];
    for await (const event of item.connector.subscribe(context('events'), { target })) events.push(event);
    assert.equal(observation.value.execution.phase, 'running');
    assert.equal(observation.value.activity?.coverage, 'partial');
    assert.deepEqual(events.filter((event) => event.payload.type === 'result.submitted'), []);
  } finally { item.ledger.close(); }
});

test('SDK background task registry is bounded and marks truncated coverage', () => {
  const tasks = Array.from({ length: 40 }, (_, index) => ({ task_id: `task-${index}`, task_type: 'local_agent',
    subagent_type: 'Explore', description: `child ${index}` }));
  const frame = parseClaudeTurnFrame({ type: 'system', subtype: 'background_tasks_changed', session_id: nativeSession.id,
    uuid: '77777777-7777-4777-8777-777777777777', tasks }, 'input', true);
  const registry = frame.messages?.[0];
  assert.equal(registry?.kind, 'subagent_registry');
  assert.equal(registry?.kind === 'subagent_registry' ? registry.tasks.length : 0, 31);
  assert.equal(registry?.kind === 'subagent_registry' ? registry.truncated : false, true);
});

test('empty complete task registry permits parent final and lifecycle extensions remain observable', async () => {
  const item = await fixture(driver(async (request) => ({ sessionId: nativeSession.id, inputId: request.inputId,
    messages: [{ kind: 'subagent', id: 'task-start', event: 'started', taskId: 'task-1', description: 'child',
      phase: 'running', ambient: false, observedAt: new Date(1).toISOString() },
    { kind: 'subagent_registry', id: 'registry', tasks: [], truncated: false, observedAt: new Date(2).toISOString() },
    { kind: 'result', frame: 'final', id: 'result', outcome: 'completed', summary: 'parent final', observedAt: new Date(3).toISOString() }] })));
  try {
    await item.connector.startAttempt(context('start'), input);
    const observation: Awaited<ReturnType<typeof item.connector.inspectSession>> = await item.connector.inspectSession(context('inspect'), target);
    const events: RuntimeEvent[] = [];
    for await (const event of item.connector.subscribe(context('events'), { target })) events.push(event);
    assert.equal(observation.value.execution.termination, 'completed');
    assert.equal(observation.value.activity?.coverage, 'complete');
    assert.equal(events.filter((event) => event.payload.type === 'result.submitted').length, 1);
    assert.ok(events.some((event) => event.payload.type === 'extension' && event.payload.namespace === 'workhub.claude.lifecycle.v1'));
    const replayGap: RuntimeEvent[] = [];
    for await (const event of item.connector.subscribe(context('gap'), { target, after: 'missing-cursor' })) replayGap.push(event);
    assert.deepEqual(replayGap.map((event) => event.payload.type), ['gap']);
  } finally { item.ledger.close(); }
});

test('Claude capabilities remain honest for native questions permissions and stop', async () => {
  const item = await fixture(driver(async (request) => ({ sessionId: nativeSession.id, inputId: request.inputId, messages: [] })));
  try {
    const capabilities = item.connector.describe().capabilities;
    assert.equal(capabilities.nativeQuestions.support, 'unsupported');
    assert.equal(capabilities.nativeApprovals.support, 'unsupported');
    assert.deepEqual(capabilities.stopModes, []);
    await assert.rejects(item.connector.requestStop(context('stop'), { target, mode: 'stop_work' }), /not supported/);
  } finally { item.ledger.close(); }
});
