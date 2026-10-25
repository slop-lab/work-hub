import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AuthStore, Identity } from './auth-store.ts';

export type ApiEnvironment = { Variables: { identity: Identity } };
export type BrowserSecurity = { readonly auth: AuthStore; readonly origin: string };

export function securityHeaders(): MiddlewareHandler {
  return async (context, next) => {
    await next();
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('X-Frame-Options', 'DENY');
    context.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    context.header('Cache-Control', 'no-store');
  };
}

export function authenticate(options: BrowserSecurity): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const authorization = context.req.header('Authorization');
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const cookie = getCookie(context, 'work_hub_session');
    const token = bearer ?? cookie;
    const identity = token ? options.auth.authenticate(token) : undefined;
    if (!identity || (!bearer && identity.kind !== 'browser') || (bearer && identity.kind === 'browser')) {
      return context.json({ error: { code: 'unauthenticated', message: 'Sign in to Work Hub.', retry: 'never' } }, 401);
    }
    if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) && context.req.header('Origin') !== options.origin) {
      return context.json({ error: { code: 'origin_denied', message: 'A same-origin request is required.', retry: 'never' } }, 403);
    }
    if (identity.kind === 'bridge' && !context.req.path.startsWith('/api/v1/bridge/')) {
      return context.json({ error: { code: 'principal_scope_denied', message: 'This credential is limited to its runtime bridge.', retry: 'never' } }, 403);
    }
    if (identity.kind !== 'bridge' && context.req.path.startsWith('/api/v1/bridge/')) {
      return context.json({ error: { code: 'principal_scope_denied', message: 'A scoped runtime bridge credential is required.', retry: 'never' } }, 403);
    }
    context.set('identity', identity);
    await next();
  };
}

export function bearerToken(context: Context): string | undefined {
  const authorization = context.req.header('Authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
}
