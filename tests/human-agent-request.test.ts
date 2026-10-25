import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthStore } from '../application/api/auth-store.ts';
import { createApplication } from '../application/api/app.ts';
import { admin, createTask, delegateNone, fixture, finishAttempt } from './acceptance-fixture.ts';

test('a scoped agent discovers and answers its human request without starting work', async () => {
  const f = fixture();
  const auth = new AuthStore(':memory:');
  try {
    // Given an explicitly delegated session and a human question addressed to it.
    const taskId = await createTask(f.hub, 'outbound');
    const attempt = await delegateNone(f.hub, taskId, 'outbound');
    const session = f.hub.getSession(admin, attempt.sessionId).session;
    const created = await f.hub.execute(admin, { commandId: 'ask-agent', type: 'request.create', payload: {
      projectId: 'project-default', taskId, sessionId: session.id, attemptId: attempt.id,
      bindingGeneration: session.bindingGeneration, kind: 'question',
      recipient: { kind: 'agent_session', sessionId: session.id }, prompt: 'What remains uncertain?',
      referenceIds: [], answerSchema: { kind: 'text', minLength: 1, maxLength: 200 },
      blocking: 'none', validity: { kind: 'task', taskId }, responseRoute: 'none',
    } });
    assert.equal(created.status, 'confirmed');
    const requestId = created.objectRefs[0]?.id;
    assert.ok(requestId);
    const calls = f.hub.simulator?.calls.list().length;
    const token = auth.issueBridge({ userId: 'agent', projectId: 'project-default', taskId,
      sessionId: session.id, attemptId: attempt.id, bindingGeneration: session.bindingGeneration,
      allowedCommands: ['request.respond'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const app = createApplication({ hub: f.hub, auth, origin: 'http://localhost:3000', secureCookies: false });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    // When the runtime polls its scoped request inbox and commits an answer.
    const inbox = await app.request('/api/v1/bridge/requests', { headers });
    assert.equal(inbox.status, 200);
    const body: unknown = await inbox.json();
    assert.ok(typeof body === 'object' && body !== null && 'items' in body && Array.isArray(body.items));
    assert.equal(body.items.length, 1);
    const response = await app.request('/api/v1/bridge/commands', { method: 'POST', headers,
      body: JSON.stringify({ commandId: 'agent-answer', type: 'request.respond', target: { kind: 'request', id: requestId },
        expected: { request: 1, bindingGeneration: session.bindingGeneration }, payload: { answer: { kind: 'text', text: 'The deployment target is not verified.' } } }) });
    // Then the canonical answer is durable and no new execution was requested.
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(f.hub.getRequest(admin, requestId).status, 'answered');
    assert.equal(f.hub.simulator?.calls.list().length, calls);
    assert.equal(f.hub.snapshot(admin).attempts.length, 1);
  } finally { auth.close(); f.close(); }
});

test('an ended agent recipient cannot retain an actionable task-valid question', async () => {
  const f = fixture();
  const auth = new AuthStore(':memory:');
  try {
    const taskId = await createTask(f.hub, 'ended-recipient');
    const attempt = await delegateNone(f.hub, taskId, 'ended-recipient');
    const session = f.hub.getSession(admin, attempt.sessionId).session;
    await f.hub.execute(admin, { commandId: 'ask-ended', type: 'request.create', payload: {
      projectId: 'project-default', taskId, sessionId: session.id, attemptId: attempt.id,
      bindingGeneration: session.bindingGeneration, kind: 'question', recipient: { kind: 'agent_session', sessionId: session.id },
      prompt: 'What remains?', referenceIds: [], answerSchema: { kind: 'text', minLength: 1, maxLength: 200 },
      blocking: 'none', validity: { kind: 'task', taskId }, responseRoute: 'none',
    } });
    await finishAttempt(f.hub, attempt);
    const actor = { ...admin, id: 'agent', role: 'runtime', sessionId: session.id,
      attemptId: attempt.id, bindingGeneration: session.bindingGeneration, allowedCommandTypes: ['request.respond'] } as const;
    assert.equal(f.hub.agentRequests(actor).length, 0);
  } finally { auth.close(); f.close(); }
});
