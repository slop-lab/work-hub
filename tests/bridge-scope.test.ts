import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthStore } from '../application/api/auth-store.ts';
import { createApplication } from '../application/api/app.ts';
import { createTask, delegateNone, fixture } from './acceptance-fixture.ts';

test('every bridge route enforces all authenticated project and task claims', async () => {
  const f = fixture();
  const auth = new AuthStore(':memory:');
  try {
    const taskId = await createTask(f.hub, 'bridge-scope');
    const attempt = await delegateNone(f.hub, taskId, 'bridge-scope');
    const app = createApplication({ hub: f.hub, auth, origin: 'http://localhost:3000', secureCookies: false });
    for (const mismatch of [{ projectId: 'other-project', taskId }, { projectId: 'project-default', taskId: 'other-task' }]) {
      const token = auth.issueBridge({ userId: 'agent', ...mismatch, sessionId: attempt.sessionId,
        attemptId: attempt.id, bindingGeneration: 1,
        allowedCommands: ['request.respond', 'result.submit', 'attempt.report', 'bridge.response.ack'],
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      for (const path of ['requests', 'responses', 'events', 'requests/unknown']) {
        assert.equal((await app.request(`/api/v1/bridge/${path}`, { headers })).status, 403, `${path}: ${JSON.stringify(mismatch)}`);
      }
      const commands = [
        { type: 'result.submit', target: { kind: 'attempt', id: attempt.id }, payload: { summary: 'Report', limitations: [], referenceIds: [], evidence: [] } },
        { type: 'attempt.report', target: { kind: 'attempt', id: attempt.id }, payload: { phase: 'running' } },
        { type: 'request.respond', target: { kind: 'request', id: 'unknown' }, payload: { answer: { kind: 'text', text: 'Answer' } } },
      ];
      for (const command of commands) {
        const response = await app.request('/api/v1/bridge/commands', { method: 'POST', headers,
          body: JSON.stringify({ commandId: `${mismatch.projectId}-${mismatch.taskId}-${command.type}`, ...command }) });
        assert.equal(response.status, 403, command.type);
      }
      assert.equal((await app.request('/api/v1/bridge/responses/unknown/ack', { method: 'POST', headers,
        body: JSON.stringify({ commandId: 'bad-ack', bindingGeneration: 1, responseDigest: 'sha256:unknown' }) })).status, 403);
    }
  } finally { auth.close(); f.close(); }
});
