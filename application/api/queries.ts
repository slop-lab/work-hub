import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Actor, Hub } from '../orchestration/hub.ts';
import type { ApiEnvironment } from './security.ts';
import { presentOutput } from './history.ts';

const taskQuery = z.strictObject({
  q: z.string().max(4096).default(''),
  projectId: z.string().optional(),
  status: z.enum(['backlog', 'active', 'review', 'done', 'canceled']).optional(),
  ownerId: z.string().optional(),
  priority: z.coerce.number().int().min(0).max(100).optional(),
  archived: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().max(2048).optional(),
});
export type QueryOptions = {
  readonly hub: Hub;
  readonly actor: (context: Context<ApiEnvironment>) => Actor;
};

export function queryRoutes({ hub, actor }: QueryOptions) {
  const app = new Hono<ApiEnvironment>();
  app.get('/tasks', (c) => {
    const query = taskQuery.parse(c.req.query());
    return c.json(hub.listTasks(actor(c), {
      search: query.q, limit: query.limit, includeArchived: query.archived === 'true',
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(query.after ? { cursor: query.after } : {}),
    }));
  });
  app.get('/dashboard', (c) => c.json(hub.snapshot(actor(c)).dashboard));
  app.get('/profiles', (c) => c.json({ items: hub.snapshot(actor(c)).profiles }));
  app.get('/environments', (c) => c.json({ items: hub.snapshot(actor(c)).environmentRegistrations }));
  app.get('/requests', (c) => c.json({ items: hub.snapshot(actor(c)).requests }));
  app.get('/sessions/:id', (c) => {
    const snapshot = hub.snapshot(actor(c));
    const session = snapshot.sessions.find((item) => item.id === c.req.param('id'));
    if (!session) return c.json({ error: { code: 'not_found' } }, 404);
    return c.json({ ...session, attempts: snapshot.attempts.filter((item) => item.sessionId === session.id), bindings: snapshot.environmentBindings.filter((item) => item.sessionId === session.id) });
  });
  app.get('/sessions/:id/output', (c) => {
    const query = z.strictObject({ after: z.coerce.number().int().min(-2147483648).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(c.req.query());
    const page = hub.getOutput(actor(c), c.req.param('id'), { after: query.after ?? -2147483648, limit: query.limit });
    const items = page.items.map(presentOutput);
    const gaps = items.filter((item) => item.kind === 'gap').map((item) => ({ reason: item.text ?? 'Retained output gap.' }));
    if (page.retainedBounds.gapCount > 0 && gaps.length === 0) gaps.push({ reason: 'Retained history contains a gap outside this page. Request the start of the retained range for its marker.' });
    const replay = z.object({ outputReplay: z.object({ support: z.string() }).optional() }).parse(page.session.capabilities).outputReplay?.support;
    return c.json({ items, ...(page.hasMore ? { nextCursor: String(page.items.at(-1)?.['localSequence']) } : {}), coverage: replay !== 'supported' ? 'live_only' : gaps.length || (query.after !== undefined && page.retainedBounds.first !== null && query.after < page.retainedBounds.first - 1) ? 'partial' : 'complete_available', gaps, retainedBounds: page.retainedBounds });
  });
  app.get('/projects', (c) => c.json({ items: hub.administration.projects.list(actor(c)) }));
  app.get('/attempts/:id', (c) => {
    const snapshot = hub.snapshot(actor(c));
    const attempt = snapshot.attempts.find((item) => item.id === c.req.param('id'));
    return attempt ? c.json(attempt) : c.json({ error: { code: 'not_found' } }, 404);
  });
  app.get('/environment-bindings/:id', (c) => {
    const snapshot = hub.snapshot(actor(c));
    const binding = snapshot.environmentBindings.find((item) => item.id === c.req.param('id'));
    return binding ? c.json(binding) : c.json({ error: { code: 'not_found' } }, 404);
  });
  return app;
}
