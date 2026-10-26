import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Hub, Actor } from '../orchestration/hub.ts';
import type { AuthStore } from './auth-store.ts';
import { loginRoutes } from './login.ts';
import { authenticate, securityHeaders, type ApiEnvironment } from './security.ts';
import { logger } from './logger.ts';
import { queryRoutes } from './queries.ts';
import { CursorError } from '../orchestration/pagination.ts';
import { HubError } from '../domain/errors.ts';
import { presentContext, presentState, presentUser } from './presentation.ts';
import { commandEnvelope } from './command-envelope.ts';
import { bridgeRoutes } from './bridge.ts';
import { presentHistory } from './history.ts';
import { exportSafeRecords } from '../artifacts/export.ts';
import { simulatorRoutes } from './simulator.ts';
import { eventRoutes } from './events.ts';
import type { ConfiguredConnections } from '../connectors/configured.ts';

export type ApplicationOptions = {
  readonly hub: Hub;
  readonly auth: AuthStore;
  readonly origin: string;
  readonly secureCookies: boolean;
  readonly connections?: ConfiguredConnections;
};

export function createApplication(options: ApplicationOptions) {
  const { hub, auth } = options;
  const app = new Hono<ApiEnvironment>();
  app.use('*', securityHeaders());
  app.use('*', bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: { code: 'body_too_large', message: 'Command body exceeds 512 KiB.' } }, 413) }));
  app.get('/health', (c) => c.json({ status: 'ok', contractMajor: 1, simulation: hub.readiness.simulated, liveReady: false }));
  app.route('/api/v1', loginRoutes({ ...options, isUserEnabled: (id) => hub.actorForUser(id) !== undefined }));
  app.use('/api/*', authenticate({ auth, origin: options.origin }));
  const actor = (c: Context<ApiEnvironment>): Actor => {
    const identity = c.get('identity');
    const user = hub.actorForUser(identity.userId);
    if (!user) throw new AccessError('User is disabled or unavailable.');
    return user;
  };
  app.get('/api/v1/me', (c) => c.json(presentUser(actor(c), hub.administration)));
  app.get('/api/v1/integrations', async (c) => c.json(options.connections === undefined ? { runtime: [], execution: [] } : await options.connections.discover(actor(c))));
  app.get('/api/v1/sessions/:id/native-link', (c) => {
    const current = actor(c);
    hub.getSession(current, c.req.param('id'));
    return c.json({ url: options.connections?.nativeLink(current, hub, c.req.param('id')) ?? null });
  });
  app.get('/api/v1/state', (c) => {
    const current = actor(c);
    return c.json(presentState({ snapshot: hub.snapshot(current), actor: current, administration: hub.administration, simulated: hub.readiness.simulated }));
  });
  app.get('/api/v1/context', (c) => {
    const current = actor(c);
    const query = z.strictObject({ route: z.enum(['dashboard', 'backlog', 'task', 'session', 'environments', 'settings', 'operation', 'showcase']), id: z.string().optional() }).parse(c.req.query());
    const context = query.id === undefined ? { route: query.route } : { route: query.route, id: query.id };
    return c.json(presentContext({ snapshot: hub.contextSnapshot(current, context), actor: current, administration: hub.administration, simulated: hub.readiness.simulated }, context));
  });
  app.post('/api/v1/commands', async (c) => {
    const command = commandEnvelope.parse(await c.req.json<unknown>());
    const receipt = await hub.execute(actor(c), command);
    if (receipt.status === 'rejected') {
      const category = receipt.error?.category;
      const status = category === 'validation' ? 422 : category === 'authorization' ? 403 : category === 'unsupported' ? 422 : 409;
      return c.json(receipt, status);
    }
    return c.json(receipt, receipt.status === 'accepted' || receipt.status === 'running' ? 202 : 200);
  });
  app.get('/api/v1/tasks/:id', (c) => c.json(hub.getTask(actor(c), c.req.param('id'))));
  app.get('/api/v1/references/:id', (c) => c.json(hub.getReference(actor(c), c.req.param('id'))));
  app.get('/api/v1/requests/:id', (c) => {
    const current = actor(c);
    const request = hub.getRequest(current, c.req.param('id'));
    const history = presentHistory(hub.snapshot(current));
    return c.json({ ...request, responses: history.responses.filter((response) => response.requestId === request.id) });
  });
  app.get('/api/v1/tasks/:id/timeline', (c) => {
    const current = actor(c);
    const task = hub.getTask(current, c.req.param('id'));
    const snapshot = hub.snapshot(current);
    return c.json({ entries: presentHistory(snapshot).entries.filter((entry) => entry.taskId === task.id), requests: snapshot.requests.filter((request) => request.taskId === task.id), results: snapshot.results.filter((result) => result.taskId === task.id), snapshotCursor: snapshot.dashboard.snapshotCursor });
  });
  app.get('/api/v1/export', (c) => {
    const current = actor(c);
    c.header('Content-Disposition', 'attachment; filename="work-hub-export.json"');
    return c.body(JSON.stringify(exportSafeRecords({ contractVersion: 'work-hub-export.v1', workspaceId: current.workspaceId, exportedAt: new Date().toISOString(), simulated: hub.readiness.simulated, records: hub.snapshot(current) })), 200, { 'Content-Type': 'application/json' });
  });
  app.get('/api/v1/commands/:id', (c) => {
    const receipt = hub.getCommandReceipt(actor(c), c.req.param('id'));
    return receipt ? c.json(receipt) : c.json({ error: { code: 'not_found' } }, 404);
  });
  app.route('/api/v1', queryRoutes({ hub, actor }));
  app.route('/api/v1/bridge', bridgeRoutes(hub));
  app.route('/api/v1/simulator', simulatorRoutes({ hub, actor }));
  app.route('/api/v1', eventRoutes({ hub, actor }));
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: { code: 'invalid_command', message: 'Command does not match the closed schema.', issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) } }, 422);
    if (error instanceof AccessError) return c.json({ error: { code: 'forbidden', message: error.message } }, 403);
    if (error instanceof SyntaxError) return c.json({ error: { code: 'invalid_json', message: 'A JSON body is required.' } }, 422);
    if (error instanceof CursorError) return c.json({ error: { code: 'invalid_cursor', message: error.message } }, 409);
    if (error instanceof HubError) {
      const status = error.data.category === 'authorization' ? 403 : error.data.category === 'validation' || error.data.category === 'unsupported' ? 422 : error.data.code === 'not_found' ? 404 : 409;
      return c.json({ error: error.data }, status);
    }
    logger.error({ err: error, path: c.req.path }, 'http.unhandled_failure');
    return c.json({ error: { code: 'internal_error', message: 'An unexpected server error occurred. See the server log.' } }, 500);
  });
  return app;
}
export class AccessError extends Error {}
