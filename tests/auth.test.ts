import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../application/api/auth-store.ts';

test('bootstrap token survives restart without storing a reusable plaintext secret', () => {
  // Given a one-time local bootstrap.
  const root = mkdtempSync(join(tmpdir(), 'work-hub-auth-'));
  const path = join(root, 'auth.sqlite');
  const first = new AuthStore(path);
  const token = first.bootstrap('user-admin');
  first.close();
  // When a new process opens the authentication store.
  const restored = new AuthStore(path);
  // Then the credential authenticates and cannot bootstrap another administrator.
  assert.equal(restored.authenticate(token)?.userId, 'user-admin');
  assert.equal(restored.authenticate('wrong-token'), undefined);
  assert.throws(() => restored.bootstrap('other-admin'), /already/);
  const serialized = restored.diagnostics();
  assert.equal(JSON.stringify(serialized).includes(token), false);
  restored.close();
  rmSync(root, { recursive: true });
});

test('browser logout revokes only that session and bridge scope is immutable', () => {
  // Given separate user and bridge credentials.
  const auth = new AuthStore(':memory:');
  const token = auth.bootstrap('user-admin');
  const bridge = auth.issueBridge({ userId: 'runtime-one', taskId: 'task-one', projectId: 'project-default', sessionId: 'session-one', attemptId: 'attempt-one', bindingGeneration: 1, allowedCommands: ['request.create', 'result.submit'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const cookie = auth.createBrowserSession('user-admin');
  // When the browser session is revoked.
  auth.revoke(cookie);
  // Then the original credential and scoped bridge remain distinct.
  assert.equal(auth.authenticate(cookie), undefined);
  assert.equal(auth.authenticate(token)?.kind, 'user');
  assert.equal(auth.authenticate(bridge)?.kind, 'bridge');
  assert.equal(auth.authenticate(bridge)?.scope?.taskId, 'task-one');
  auth.close();
});

test('expired bridge credentials cannot authenticate', () => {
  // Given an already expired scope.
  const auth = new AuthStore(':memory:');
  const token = auth.issueBridge({ userId: 'runtime-one', taskId: 'task-one', projectId: 'project-default', sessionId: 'session-one', attemptId: 'attempt-one', bindingGeneration: 1, allowedCommands: ['result.submit'], expiresAt: '2000-01-01T00:00:00.000Z' });
  // When it authenticates, then the server clock rejects it.
  assert.equal(auth.authenticate(token), undefined);
  auth.close();
});
