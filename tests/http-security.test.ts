import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { AuthStore } from '../application/api/auth-store.ts';
import { authenticate, securityHeaders, type ApiEnvironment } from '../application/api/security.ts';

function fixture() {
  const auth = new AuthStore(':memory:');
  const app = new Hono<ApiEnvironment>();
  app.use('*', securityHeaders());
  app.use('/api/*', authenticate({ auth, origin: 'http://localhost:3000' }));
  app.all('/api/v1/state', (c) => c.json({ id: c.get('identity').userId }));
  app.all('/api/v1/bridge/commands', (c) => c.json({ id: c.get('identity').userId }));
  return { auth, app };
}

test('unauthenticated data is denied at the HTTP boundary', async () => {
  const { auth, app } = fixture();
  const response = await app.request('/api/v1/state');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  auth.close();
});

test('cross-origin browser mutations are denied while a same-origin command is allowed', async () => {
  const { auth, app } = fixture();
  const token = auth.createBrowserSession('user-admin');
  const headers = { Cookie: `work_hub_session=${token}`, Origin: 'https://attacker.invalid' };
  const denied = await app.request('/api/v1/state', { method: 'POST', headers });
  assert.equal(denied.status, 403);
  const permitted = await app.request('/api/v1/state', { method: 'POST', headers: { ...headers, Origin: 'http://localhost:3000' } });
  assert.equal(permitted.status, 200);
  auth.close();
});

test('runtime credentials cannot become user credentials or administrator cookies', async () => {
  const { auth, app } = fixture();
  const token = auth.issueBridge({ userId: 'runtime-one', projectId: 'project-default', taskId: 'task-one', sessionId: 'session-one', attemptId: 'attempt-one', bindingGeneration: 1, allowedCommands: ['request.create'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await app.request('/api/v1/state', { headers: { Authorization: `Bearer ${token}` } })).status, 403);
  assert.equal((await app.request('/api/v1/state', { headers: { Cookie: `work_hub_session=${token}` } })).status, 401);
  assert.equal((await app.request('/api/v1/bridge/commands', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 200);
  auth.close();
});
