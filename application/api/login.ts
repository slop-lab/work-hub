import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AuthStore } from './auth-store.ts';

export type LoginOptions = {
  readonly auth: AuthStore;
  readonly origin: string;
  readonly secureCookies: boolean;
  readonly isUserEnabled: (id: string) => boolean;
};
const loginSchema = z.strictObject({ token: z.string().min(1).max(512) });

export function loginRoutes(options: LoginOptions) {
  const app = new Hono();
  let windowStarted = Date.now();
  let failures = 0;
  app.post('/login', async (c) => {
    if (c.req.header('Origin') !== options.origin) {
      return c.json({ error: { code: 'origin_denied', message: 'Sign in from this application origin.' } }, 403);
    }
    if (Date.now() - windowStarted > 60_000) { failures = 0; windowStarted = Date.now(); }
    if (failures >= 20) return c.json({ error: { code: 'rate_limited', message: 'Too many failed sign-in attempts. Try again in a minute.' } }, 429);
    const parsed = loginSchema.safeParse(await c.req.json<unknown>());
    if (!parsed.success) return c.json({ error: { code: 'invalid_login', message: 'Enter the token from your local bootstrap command.' } }, 422);
    const identity = options.auth.authenticate(parsed.data.token);
    if (!identity || identity.kind !== 'user' || !options.isUserEnabled(identity.userId)) {
      failures += 1;
      return c.json({ error: { code: 'invalid_credentials', message: 'The token is invalid or the user is disabled.' } }, 401);
    }
    setCookie(c, 'work_hub_session', options.auth.createBrowserSession(identity.userId), {
      httpOnly: true, sameSite: 'Strict', secure: options.secureCookies, path: '/', maxAge: 12 * 3600,
    });
    return c.json({ userId: identity.userId });
  });
  app.post('/logout', (c) => {
    if (c.req.header('Origin') !== options.origin) return c.json({ error: { code: 'origin_denied' } }, 403);
    const token = getCookie(c, 'work_hub_session');
    if (!token || options.auth.authenticate(token)?.kind !== 'browser') return c.json({ error: { code: 'unauthenticated' } }, 401);
    options.auth.revoke(token);
    deleteCookie(c, 'work_hub_session', { path: '/', secure: options.secureCookies });
    return c.json({ signedOut: true });
  });
  return app;
}
