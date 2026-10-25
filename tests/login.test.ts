import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthStore } from '../application/api/auth-store.ts';
import { loginRoutes } from '../application/api/login.ts';

test('login exchanges a user token for a scoped HttpOnly cookie, never a bridge token', async () => {
  const auth = new AuthStore(':memory:');
  const token = auth.bootstrap('user-admin');
  const app = loginRoutes({ auth, origin: 'http://localhost:3000', secureCookies: false, isUserEnabled: () => true });
  const response = await app.request('/login', { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(cookie.includes(token), false);
  auth.close();
});

test('disabled users cannot establish a browser session', async () => {
  const auth = new AuthStore(':memory:');
  const token = auth.bootstrap('user-admin');
  const app = loginRoutes({ auth, origin: 'http://localhost:3000', secureCookies: true, isUserEnabled: () => false });
  const response = await app.request('/login', { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.has('set-cookie'), false);
  auth.close();
});
