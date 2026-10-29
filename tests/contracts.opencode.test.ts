import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeRuntimeConnector } from '../application/connectors/opencode/runtime.ts';
import { digest } from '../application/persistence/codec.ts';
import { context, openCodeFixture } from './opencode-fixture.ts';

test('discovery uses configured providers rather than downloading the global model catalog', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    assert.equal(fixture.calls.some((call) => call.path === '/provider'), false);
    assert.equal(fixture.calls.some((call) => call.path === '/config/providers'), true);
  } finally { await fixture.close(); }
});

test('HTTP 204 without a persisted message stays uncertain and cannot replay', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    fixture.state.persist = false;
    const receipt = await fixture.connector.startAttempt(context('start'), fixture.input);
    assert.equal(receipt.status, 'unknown');
    const restarted = new OpenCodeRuntimeConnector(fixture.ledger, fixture.connection);
    await restarted.startAttempt(context('start'), fixture.input);
    assert.equal(fixture.calls.filter((call) => call.path.endsWith('prompt_async')).length, 1);
    const observation = await restarted.inspectSession(context('inspect'), fixture.target);
    assert.equal(observation.value.execution.phase, 'unknown');
  } finally { await fixture.close(); }
});

test('exact message receipt confirms delivery but not execution or task success', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    assert.equal((await fixture.connector.startAttempt(context('start'), fixture.input)).status, 'confirmed');
    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);
    assert.equal(observation.value.execution.phase, 'unknown');
    assert.equal((await fixture.connector.readOutput(context('output'), { target: fixture.target, limit: 10 })).items[0]?.role, 'user');
    const events = [];
    for await (const event of fixture.connector.subscribe(context('events'), { target: fixture.target })) events.push(event);
    assert.equal(events.length, 0);
  } finally { await fixture.close(); }
});

test('session attachment sends no prompt and validates directory', async () => {
  const fixture = await openCodeFixture();
  try {
    fixture.state.directory = '/replaced';
    await assert.rejects(fixture.open(), /working directory/);
    assert.equal(fixture.calls.some((call) => call.method === 'POST'), false);
  } finally { await fixture.close(); }
});

test('unavailable saved agent is explicit and never silently substituted', async () => {
  const fixture = await openCodeFixture();
  try {
    fixture.state.agentAvailable = false;
    await assert.rejects(fixture.open(), /saved agent or connected model is unavailable/);
    assert.equal(fixture.calls.some((call) => call.method === 'POST'), false);
  } finally { await fixture.close(); }
});

test('completed associated assistant output becomes a result without auto-completing task', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const parentID = fixture.messages[0]?.info.id;
    assert.ok(parentID);
    fixture.messages.push({ info: { id: 'msg_assistant', sessionID: 'ses_fixture', role: 'assistant', parentID,
      finish: 'stop', time: { created: 2, completed: 3 } }, parts: [{ id: 'prt_result', type: 'text', text: 'Fixture result' }] });
    const events = [];
    for await (const event of fixture.connector.subscribe(context('events'), { target: fixture.target })) events.push(event);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.type, 'result.submitted');
    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);
    assert.equal(observation.value.execution.termination, 'completed');
  } finally { await fixture.close(); }
});

test('native question response reaches only its bound question endpoint', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const parentID = fixture.messages[0]?.info.id;
    assert.ok(parentID);
    fixture.messages.push({ info: { id: 'msg_assistant', sessionID: 'ses_fixture', role: 'assistant', parentID,
      time: { created: 2 } }, parts: [] });
    fixture.state.question = true;
    const events = [];
    for await (const event of fixture.connector.subscribe(context('events'), { target: fixture.target })) events.push(event);
    const event = events[0];
    assert.ok(event?.payload.type === 'request.created');
    const request = event.payload.request;
    const receipt = await fixture.connector.deliverResponse(context('answer'), { target: fixture.target,
      requestId: 'request', requestRevision: 1, responseId: 'response', responseDigest: 'sha256:123',
      nativeRequestRef: request.nativeRequestRef, validity: request.draft.validity, answer: { kind: 'text', text: 'chosen' } });
    assert.equal(receipt.status, 'confirmed');
    assert.deepEqual(fixture.calls.find((call) => call.path.endsWith('/reply'))?.body, { answers: [['chosen']] });
  } finally { await fixture.close(); }
});

test('native history outside Hub-owned input ancestry is never imported', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    fixture.messages.push({ info: { id: 'msg_private', sessionID: 'ses_fixture', role: 'user', time: { created: 0 } },
      parts: [{ id: 'prt_private', type: 'text', text: 'unrelated private native history' }] });
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const output = await fixture.connector.readOutput(context('output'), { target: fixture.target, limit: 100 });
    assert.equal(output.items.length, 1);
    assert.equal(output.items.some((item) => item.sourceItemId?.startsWith('msg_private')), false);
  } finally { await fixture.close(); }
});

test('unrelated native question cannot mark the current Hub attempt waiting', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    fixture.messages.push({ info: { id: 'msg_assistant', parentID: 'msg_external', sessionID: 'ses_fixture', role: 'assistant', time: { created: 2 } }, parts: [] });
    fixture.state.question = true;
    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);
    assert.equal(observation.value.execution.phase, 'unknown');
    assert.deepEqual(observation.value.execution.pendingNativeRequestRefs, []);
  } finally { await fixture.close(); }
});

test('runtime input requires the recorded control grant in the action context', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await assert.rejects(fixture.connector.startAttempt({ ...context('start'), authorizedGrantRefs: [] }, fixture.input), /grant/);
    assert.equal(fixture.calls.some((call) => call.path.endsWith('prompt_async')), false);
  } finally { await fixture.close(); }
});

test('verification handoff sends the canonical rendered instruction rather than snapshot JSON', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    const instruction = 'Canonical verification handoff prompt';
    const receipt = await fixture.connector.startAttempt(context('start'), { ...fixture.input,
      input: { ...fixture.input.input, instruction, promptDigest: digest(instruction) } });
    const prompt = fixture.calls.find((call) => call.path.endsWith('/prompt_async'))?.body;
    assert.equal(receipt.status, 'confirmed');
    assert.deepEqual(prompt, { messageID: receipt.status === 'confirmed' ? receipt.result.nativeInputRef?.id : undefined,
      agent: fixture.input.target.nativeSession.id === 'ses_fixture' ? 'fixture-agent' : '',
      model: { providerID: 'fixture-provider', modelID: 'fixture-model' }, parts: [{ type: 'text', text: instruction }] });
  } finally { await fixture.close(); }
});

test('stale verification prompt digest is rejected before native delivery', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await assert.rejects(fixture.connector.startAttempt(context('start'), { ...fixture.input,
      input: { ...fixture.input.input, instruction: 'Changed after preview', promptDigest: digest('Original preview') } }), /prompt digest/);
    assert.equal(fixture.calls.some((call) => call.path.endsWith('/prompt_async')), false);
  } finally { await fixture.close(); }
});
