import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeRuntimeConnector } from '../application/connectors/opencode/runtime.ts';
import type { NativeMessage } from '../application/connectors/opencode/schema.ts';
import { context, openCodeFixture } from './opencode-fixture.ts';

function completedParent(rootMessageId: string, childSessionId?: string): NativeMessage {
  return { info: { id: 'msg_parent_result', sessionID: 'ses_fixture', role: 'assistant', parentID: rootMessageId,
    finish: 'stop', time: { created: 2, completed: 3 } }, parts: [
      ...(childSessionId === undefined ? [] : [{ id: 'prt_tool', type: 'tool', tool: 'call_omo_agent',
        state: { status: 'completed', output: `<task_metadata>\nsession_id: ${childSessionId}\n</task_metadata>` } }]),
      { id: 'prt_result', type: 'text', text: 'Fixture result' },
    ] };
}

async function resultEvents(fixture: Awaited<ReturnType<typeof openCodeFixture>>) {
  const events = [];
  for await (const event of fixture.connector.subscribe(context('events'), { target: fixture.target })) events.push(event);
  return events.filter((event) => event.payload.type === 'result.submitted');
}

test('parent completion remains running while an affiliated child session is busy', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const root = fixture.messages[0]?.info.id;
    assert.ok(root);
    const childId = 'ses_childbusy';
    fixture.messages.push(completedParent(root, childId));
    fixture.state.children.set('ses_fixture', [{ id: childId, directory: '/fixture', parentID: 'ses_fixture' }]);
    fixture.state.statuses[childId] = { type: 'busy' };

    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);

    assert.equal(observation.value.execution.phase, 'running');
    assert.equal(observation.value.execution.termination, undefined);
    assert.deepEqual(await resultEvents(fixture), []);
  } finally { await fixture.close(); }
});

test('unrelated busy native children cannot hold or complete the owned attempt', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const root = fixture.messages[0]?.info.id;
    assert.ok(root);
    fixture.messages.push(completedParent(root));
    fixture.state.children.set('ses_fixture', [{ id: 'ses_unrelated', directory: '/fixture', parentID: 'ses_fixture' }]);
    fixture.state.statuses['ses_unrelated'] = { type: 'busy' };

    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);

    assert.equal(observation.value.execution.termination, 'completed');
    assert.equal((await resultEvents(fixture)).length, 1);
  } finally { await fixture.close(); }
});

test('an affiliated idle child permits the exact parent result', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const root = fixture.messages[0]?.info.id;
    assert.ok(root);
    const childId = 'ses_childidle';
    fixture.messages.push(completedParent(root, childId));
    fixture.state.children.set('ses_fixture', [{ id: childId, directory: '/fixture', parentID: 'ses_fixture' }]);
    fixture.state.statuses[childId] = { type: 'idle' };

    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);

    assert.equal(observation.value.execution.termination, 'completed');
    assert.equal((await resultEvents(fixture)).length, 1);
  } finally { await fixture.close(); }
});

test('lost retained child projection after connector restart becomes unknown instead of completed', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const root = fixture.messages[0]?.info.id;
    assert.ok(root);
    const childId = 'ses_childretained';
    fixture.messages.push(completedParent(root, childId));
    fixture.state.children.set('ses_fixture', [{ id: childId, directory: '/fixture', parentID: 'ses_fixture' }]);
    fixture.state.statuses[childId] = { type: 'busy' };
    assert.equal((await fixture.connector.inspectSession(context('first'), fixture.target)).value.execution.phase, 'running');
    fixture.state.children.set('ses_fixture', []);
    fixture.state.statuses = {};
    const restarted = new OpenCodeRuntimeConnector(fixture.ledger, fixture.connection);

    const observation = await restarted.inspectSession(context('restart'), fixture.target);

    assert.equal(observation.value.execution.phase, 'unknown');
    assert.equal(observation.value.execution.termination, undefined);
  } finally { await fixture.close(); }
});

test('tool-linked child missing before first observation is unknown instead of completed', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const root = fixture.messages[0]?.info.id;
    assert.ok(root);
    fixture.messages.push(completedParent(root, 'ses_childlost'));

    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);

    assert.equal(observation.value.execution.phase, 'unknown');
    assert.equal(observation.value.execution.termination, undefined);
    assert.deepEqual(await resultEvents(fixture), []);
  } finally { await fixture.close(); }
});

test('unavailable child status coverage cannot publish parent completion or result', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const root = fixture.messages[0]?.info.id;
    assert.ok(root);
    fixture.messages.push(completedParent(root, 'ses_childunknown'));
    fixture.state.children.set('ses_fixture', [{ id: 'ses_childunknown', directory: '/fixture', parentID: 'ses_fixture' }]);
    fixture.state.statusAvailable = false;

    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);

    assert.equal(observation.value.execution.phase, 'unknown');
    assert.deepEqual(await resultEvents(fixture), []);
  } finally { await fixture.close(); }
});

test('child traversal is bounded and truncated coverage cannot publish completion', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const root = fixture.messages[0]?.info.id;
    assert.ok(root);
    const children = Array.from({ length: 40 }, (_, index) => ({ id: `ses_child${index}`, directory: '/fixture', parentID: 'ses_fixture' }));
    fixture.messages.push({ ...completedParent(root), parts: [
      { id: 'prt_tool', type: 'tool', tool: 'team_create', state: { status: 'completed', output: children.map((child) => child.id).join(' ') } },
      { id: 'prt_result', type: 'text', text: 'Fixture result' },
    ] });
    fixture.state.children.set('ses_fixture', children);

    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);

    assert.equal(observation.value.execution.phase, 'unknown');
    assert.ok(fixture.calls.filter((call) => call.path.endsWith('/children')).length <= 32);
    assert.ok(fixture.calls.filter((call) => call.path.endsWith('/message')).every((call) => call.search.includes('limit=100')));
  } finally { await fixture.close(); }
});

test('descendant traversal is depth bounded and partial ancestry cannot publish completion', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const root = fixture.messages[0]?.info.id;
    assert.ok(root);
    fixture.messages.push(completedParent(root, 'ses_depth1'));
    for (let depth = 1; depth <= 5; depth += 1) {
      const parentId = `ses_depth${depth}`;
      const childId = `ses_depth${depth + 1}`;
      fixture.state.children.set(parentId, [{ id: childId, directory: '/fixture', parentID: parentId }]);
      fixture.childMessages.set(parentId, [{ info: { id: `msg_depth${depth}`, sessionID: parentId, role: 'assistant',
        time: { created: depth } }, parts: [{ id: `prt_depth${depth}`, type: 'tool', tool: 'call_omo_agent',
          state: { status: 'completed', output: childId } }] }]);
    }
    fixture.state.children.set('ses_fixture', [{ id: 'ses_depth1', directory: '/fixture', parentID: 'ses_fixture' }]);

    const observation = await fixture.connector.inspectSession(context('inspect'), fixture.target);

    assert.equal(observation.value.execution.phase, 'unknown');
    assert.deepEqual(await resultEvents(fixture), []);
  } finally { await fixture.close(); }
});

test('exact input recovery confirms the original operation without resending and preserves result ancestry', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    fixture.state.persist = false;
    assert.equal((await fixture.connector.startAttempt(context('start'), fixture.input)).status, 'unknown');
    const prompt = fixture.calls.find((call) => call.path.endsWith('/prompt_async'))?.body;
    const parsed = typeof prompt === 'object' && prompt !== null && 'messageID' in prompt && 'parts' in prompt ? prompt : undefined;
    assert.ok(parsed && typeof parsed.messageID === 'string' && Array.isArray(parsed.parts));
    fixture.messages.push({ info: { id: parsed.messageID, sessionID: 'ses_fixture', role: 'user', time: { created: 1 } },
      parts: [{ id: 'prt_recovered', type: 'text', text: fixture.input.input.instruction }] });
    const restarted = new OpenCodeRuntimeConnector(fixture.ledger, fixture.connection);

    const lookup = await restarted.lookupOperation(context('lookup'), 'start');
    const replay = await restarted.startAttempt(context('start'), fixture.input);
    fixture.messages.push(completedParent(parsed.messageID));
    const observation = await restarted.inspectSession(context('inspect'), fixture.target);

    assert.equal(lookup.kind === 'found' ? lookup.receipt.status : 'missing', 'confirmed');
    assert.equal(replay.status, 'confirmed');
    assert.equal(fixture.calls.filter((call) => call.path.endsWith('/prompt_async')).length, 1);
    assert.equal(observation.value.execution.termination, 'completed');
  } finally { await fixture.close(); }
});

test('stale binding generation is rejected before native activity reads', async () => {
  const fixture = await openCodeFixture();
  try {
    await fixture.open();
    await fixture.connector.startAttempt(context('start'), fixture.input);
    const reads = fixture.calls.length;

    await assert.rejects(fixture.connector.inspectSession(context('stale'), { ...fixture.target, bindingGeneration: 2 }), /generation is not current/);

    assert.equal(fixture.calls.length, reads);
  } finally { await fixture.close(); }
});
