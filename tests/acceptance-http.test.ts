import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AuthStore } from '../application/api/auth-store.ts';
import { createApplication } from '../application/api/app.ts';
import { Hub } from '../application/orchestration/hub.ts';

test('AT-01/04: authenticated HTTP capture persists across restart and command replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-hub-http-'));
  const path = join(directory, 'hub.sqlite');
  const auth = new AuthStore(join(directory, 'auth.sqlite'));
  const token = auth.bootstrap('user-admin');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const hub = new Hub(path);
  const app = createApplication({ hub, auth, origin: 'http://localhost:3000', secureCookies: false });
  const command = { commandId: 'http-capture', type: 'task.create', payload: { projectId: 'project-default', title: 'Investigate startup latency' } };
  const response = await app.request('/api/v1/commands', { method: 'POST', headers, body: JSON.stringify(command) });
  assert.equal(response.status, 200);
  const original: unknown = await response.json();
  const receipt = z.object({ status: z.literal('confirmed'), objectRefs: z.array(z.object({ id: z.string() })) }).parse(original);
  const taskId = receipt.objectRefs[0]?.id;
  assert.ok(taskId);
  hub.close();
  const restored = new Hub(path);
  const second = createApplication({ hub: restored, auth, origin: 'http://localhost:3000', secureCookies: false });
  const replay = await second.request('/api/v1/commands', { method: 'POST', headers, body: JSON.stringify(command) });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), original);
  const task = await second.request(`/api/v1/tasks/${taskId}`, { headers });
  assert.equal(task.status, 200);
  assert.equal(z.object({ title: z.string() }).parse(await task.json()).title, command.payload.title);
  restored.close(); auth.close(); rmSync(directory, { recursive: true });
});

test('HTTP command validation refuses impersonation and unknown core fields', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-hub-http-validation-'));
  const auth = new AuthStore(':memory:');
  const token = auth.bootstrap('user-admin');
  const hub = new Hub(join(directory, 'hub.sqlite'));
  const app = createApplication({ hub, auth, origin: 'http://localhost:3000', secureCookies: false });
  const response = await app.request('/api/v1/commands', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: 'spoof', type: 'task.create', actorId: 'other-person', payload: { projectId: 'project-default', title: 'Not accepted' } }) });
  assert.equal(response.status, 422);
  hub.close(); auth.close(); rmSync(directory, { recursive: true });
});

test('bounded browser context omits workspace task collections while task search paginates on the server', async () => {
  // Given
  const directory = mkdtempSync(join(tmpdir(), 'work-hub-http-context-'));
  const auth = new AuthStore(':memory:');
  const token = auth.bootstrap('user-admin');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const hub = new Hub(join(directory, 'hub.sqlite'));
  const app = createApplication({ hub, auth, origin: 'http://localhost:3000', secureCookies: false });
  for (const title of ['Bounded alpha', 'Bounded beta', 'Bounded gamma']) {
    const response = await app.request('/api/v1/commands', { method: 'POST', headers, body: JSON.stringify({ commandId: `create-${title}`, type: 'task.create', payload: { projectId: 'project-default', title } }) });
    assert.equal(response.status, 200);
  }

  // When
  const context = await app.request('/api/v1/context?route=backlog', { headers });
  const first = await app.request('/api/v1/tasks?q=Bounded&limit=2', { headers });
  const firstBody = z.object({ items: z.array(z.object({ title: z.string() })), nextCursor: z.string(), snapshotCursor: z.string() }).parse(await first.json());
  const second = await app.request(`/api/v1/tasks?q=Bounded&limit=2&after=${encodeURIComponent(firstBody.nextCursor)}`, { headers });
  const secondBody = z.object({ items: z.array(z.object({ title: z.string() })), snapshotCursor: z.string() }).parse(await second.json());

  // Then
  assert.equal(context.status, 200);
  assert.deepEqual(z.object({ tasks: z.array(z.unknown()) }).parse(await context.json()).tasks, []);
  assert.equal(firstBody.items.length, 2);
  assert.equal(secondBody.items.length, 1);
  assert.equal(new Set([...firstBody.items, ...secondBody.items].map((item) => item.title)).size, 3);
  hub.close(); auth.close(); rmSync(directory, { recursive: true });
});

test('AT-02/24: another authenticated client reads a committed human answer after server restart, without external effects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-hub-human-question-'));
  const path = join(directory, 'hub.sqlite');
  const authPath = join(directory, 'auth.sqlite');
  const hub = new Hub(path);
  const auth = new AuthStore(authPath);
  const admin = hub.actorForUser('user-admin');
  assert.ok(admin);
  const firstToken = auth.bootstrap('user-admin');
  const memberReceipt = await hub.execute(admin, { commandId: 'second-human', type: 'user.create', payload: { displayName: 'Review partner', role: 'member', projectIds: ['project-default'], profileIds: [], bindingIds: [] } });
  const memberId = memberReceipt.objectRefs[0]?.id;
  assert.ok(memberId);
  const secondToken = auth.issueUser(memberId);
  const app = createApplication({ hub, auth, origin: 'http://localhost:3000', secureCookies: false });
  const created = await app.request('/api/v1/commands', { method: 'POST', headers: { Authorization: `Bearer ${firstToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: 'human-question', type: 'request.create', payload: { kind: 'question', projectId: 'project-default', recipient: { kind: 'project_members', projectId: 'project-default' }, prompt: 'Which release is the target?', referenceIds: [], answerSchema: { kind: 'text', minLength: 1, maxLength: 100 }, blocking: 'none', validity: { kind: 'project', projectId: 'project-default' } } }) });
  assert.equal(created.status, 200);
  const requestId = z.object({ objectRefs: z.array(z.object({ id: z.string() })) }).parse(await created.json()).objectRefs[0]?.id;
  assert.ok(requestId);
  const answer = await app.request('/api/v1/commands', { method: 'POST', headers: { Authorization: `Bearer ${secondToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: 'second-human-answer', type: 'request.respond', target: { kind: 'request', id: requestId }, expected: { request: 1 }, payload: { answer: { kind: 'text', text: 'The next minor release.' } } }) });
  assert.equal(answer.status, 200);
  assert.equal(hub.simulator?.calls.list().length, 0);
  hub.close(); auth.close();
  const restored = new Hub(path);
  const restoredAuth = new AuthStore(authPath);
  const next = createApplication({ hub: restored, auth: restoredAuth, origin: 'http://localhost:3000', secureCookies: false });
  const read = await next.request(`/api/v1/requests/${requestId}`, { headers: { Authorization: `Bearer ${firstToken}` } });
  const body = z.object({ status: z.literal('answered'), responses: z.array(z.object({ authorId: z.string(), answer: z.object({ kind: z.literal('text'), text: z.string() }) })) }).parse(await read.json());
  assert.equal(body.responses[0]?.authorId, memberId);
  assert.equal(body.responses[0]?.answer.text, 'The next minor release.');
  restored.close(); restoredAuth.close(); rmSync(directory, { recursive: true });
});
