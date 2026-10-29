import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexContext, codexFixture } from '../codex-fixture.ts';

test('completed affiliated Codex turn reports output and result but never task completion', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(codexContext('start'), fixture.input);
    const thread = fixture.protocol.threads.get(fixture.target.nativeSession.id) as { readonly turns: readonly Record<string, unknown>[] };
    const turn = thread.turns[0];
    assert.ok(turn);
    fixture.protocol.threads.set(fixture.target.nativeSession.id, { ...thread, status: { type: 'idle' }, turns: [{ ...turn,
      status: 'completed', completedAt: 3, items: [...((turn['items'] as readonly unknown[]) ?? []),
        { type: 'agentMessage', id: 'agent-1', text: 'Fixture result', phase: 'final_answer', questions: null }] }] });
    const output = await fixture.connector.readOutput(codexContext('output'), { target: fixture.target, limit: 10 });
    assert.equal(output.items.at(-1)?.text, 'Fixture result');
    const events = [];
    for await (const event of fixture.connector.subscribe(codexContext('events'), { target: fixture.target })) events.push(event);
    assert.equal(events.at(-1)?.payload.type, 'result.submitted');
    assert.equal((await fixture.connector.inspectSession(codexContext('inspect'), fixture.target)).value.execution.termination, 'completed');
  } finally { await fixture.close(); }
});

test('Codex inspection reports child activity as unknown instead of claiming complete coverage', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(codexContext('start'), fixture.input);
    const observation = await fixture.connector.inspectSession(codexContext('inspect-activity'), fixture.target);
    assert.equal(observation.value.activity?.coverage, 'unknown');
    assert.equal(observation.value.activity?.nodes[0]?.relation, 'root');
    assert.equal(observation.value.limitations.some((item) => item.includes('reconciliation')), true);
  } finally { await fixture.close(); }
});

test('Codex notifications expose exact turn, tool, retry and rate lifecycle metadata', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(codexContext('start'), fixture.input);
    fixture.protocol.events.push(
      { method: 'turn/started', params: { threadId: fixture.target.nativeSession.id, turn: {
        id: '01900000-0000-7000-8000-000000000002', status: 'inProgress', startedAt: 2, completedAt: null, error: null, items: [],
      } } },
      { method: 'item/started', params: { threadId: fixture.target.nativeSession.id,
        turnId: '01900000-0000-7000-8000-000000000002', startedAtMs: 2_500,
        item: { type: 'commandExecution', id: 'command-1' } } },
      { method: 'error', params: { threadId: fixture.target.nativeSession.id,
        turnId: '01900000-0000-7000-8000-000000000002', willRetry: true,
        error: { message: 'temporary provider failure', codexErrorInfo: 'serverOverloaded', additionalDetails: null, misalignment: null } } },
      { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', limitName: 'Codex', normalModelSlug: 'fixture-model',
        primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: 120 }, secondary: null, credits: null,
        individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null } } },
    );
    const events = [];
    for await (const event of fixture.connector.subscribe(codexContext('events'), { target: fixture.target })) events.push(event);
    const lifecycle = events.flatMap((event) => event.payload.type === 'extension' && event.payload.namespace === 'workhub.codex.lifecycle.v1'
      ? [event.payload.data] : []);
    assert.deepEqual(lifecycle.map((item) => item['kind']), ['turn_started', 'item_started', 'retry_observed', 'rate_limit_observed']);
    assert.deepEqual(lifecycle[1], { kind: 'item_started', itemId: 'command-1', itemType: 'commandExecution',
      threadId: fixture.target.nativeSession.id, turnId: '01900000-0000-7000-8000-000000000002', observedAtMs: 2_500 });
    assert.deepEqual(lifecycle[2], { kind: 'retry_observed', errorKind: 'serverOverloaded', willRetry: true,
      retryOrdinal: null, retryLimit: null,
      threadId: fixture.target.nativeSession.id, turnId: '01900000-0000-7000-8000-000000000002' });
    assert.deepEqual(lifecycle[3], { kind: 'rate_limit_observed', scope: 'account', limitId: 'codex', usedPercent: 75, resetsAt: 120 });
  } finally { await fixture.close(); }
});

test('Codex maps one non-secret native question and delivers its exact JSON-RPC answer', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(codexContext('start'), fixture.input);
    const params = { threadId: fixture.target.nativeSession.id, turnId: '01900000-0000-7000-8000-000000000002',
      itemId: 'question-item', questions: [{ id: 'question-1', header: 'Choice', question: 'Pick one', isOther: false,
        isSecret: false, options: [{ label: 'Alpha', description: 'First' }, { label: 'Beta', description: 'Second' }] }],
      isBlocking: true, autoResolutionMs: null };
    fixture.protocol.queueServerRequest({ method: 'item/tool/requestUserInput', params, nativeRequestId: 'native-question' });
    const waiting = await fixture.connector.inspectSession(codexContext('waiting'), fixture.target);
    assert.equal(waiting.value.execution.phase, 'waiting_input');
    assert.equal(waiting.value.execution.pendingNativeRequestRefs[0]?.id, 'native-question');
    const events = [];
    for await (const event of fixture.connector.subscribe(codexContext('questions'), { target: fixture.target })) events.push(event);
    const created = events.find((event) => event.payload.type === 'request.created');
    assert.equal(created?.payload.type, 'request.created');
    if (created?.payload.type !== 'request.created') return;
    assert.deepEqual(created.payload.request.draft.answerSchema, { kind: 'single_choice', options: [
      { id: '0', label: 'Alpha' }, { id: '1', label: 'Beta' },
    ] });
    const nativeRequestRef = created.payload.request.nativeRequestRef;
    const revision = created.payload.request.nativeRequestRevision;
    assert.ok(revision);
    const receipt = await fixture.connector.deliverResponse(codexContext('answer'), {
      target: fixture.target, requestId: 'request', requestRevision: 1, responseId: 'response', responseDigest: 'sha256:123',
      nativeRequestRef, validity: { kind: 'attempt', target: fixture.target, nativeRequestRef, nativeRequestRevision: revision },
      answer: { kind: 'single_choice', optionId: '1' },
    });
    assert.equal(receipt.status === 'confirmed' && receipt.result.responseId, 'response');
    const replay = await fixture.connector.deliverResponse(codexContext('answer'), {
      target: fixture.target, requestId: 'request', requestRevision: 1, responseId: 'response', responseDigest: 'sha256:123',
      nativeRequestRef, validity: { kind: 'attempt', target: fixture.target, nativeRequestRef, nativeRequestRevision: revision },
      answer: { kind: 'single_choice', optionId: '1' },
    });
    assert.deepEqual(replay, receipt);
    assert.deepEqual(fixture.protocol.serverResponses, [{ nativeRequestId: 'native-question',
      result: { answers: { 'question-1': { answers: ['Beta'] } } } }]);
  } finally { await fixture.close(); }
});

test('Codex exposes manual fallback instead of bridging secret or multi-question requests', async () => {
  const fixture = codexFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(codexContext('start'), fixture.input);
    fixture.protocol.events.push({ method: 'workhub/serverRequestUnsupported', params: {
      method: 'item/tool/requestUserInput', reason: 'secret_or_multiple_questions',
      threadId: fixture.target.nativeSession.id, turnId: '01900000-0000-7000-8000-000000000002',
    } });
    const events = [];
    for await (const event of fixture.connector.subscribe(codexContext('fallback'), { target: fixture.target })) events.push(event);
    assert.equal(events.some((event) => event.payload.type === 'gap' && event.payload.reason.includes('native Codex client')), true);
    assert.equal(events.some((event) => event.payload.type === 'request.created'), false);
  } finally { await fixture.close(); }
});
