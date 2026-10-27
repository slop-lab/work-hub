import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { akbCaptureSchema, type AkbContextService } from '../connectors/akb/index.ts';
import type { Actor } from '../domain/authorization.ts';
import type { ApiEnvironment } from './security.ts';

type ExternalContextRouteOptions = {
  readonly service: AkbContextService;
  readonly actor: (context: Context<ApiEnvironment>) => Actor;
};

export function externalContextRoutes(options: ExternalContextRouteOptions) {
  const app = new Hono<ApiEnvironment>();
  app.get('/external-context/akb', (context) => {
    const actor = options.actor(context);
    const query = z.strictObject({ projectId: z.string().min(1).max(200) }).parse(context.req.query());
    return context.json({ connections: options.service.connections(actor, query.projectId) });
  });
  app.get('/external-context/akb/:installationId/pages', async (context) => {
    const actor = options.actor(context);
    const query = z.strictObject({ projectId: z.string().min(1).max(200),
      parentPageId: z.string().min(1).max(200).optional() }).parse(context.req.query());
    return context.json({ pages: await options.service.list(actor, query.projectId,
      context.req.param('installationId'), query.parentPageId ?? null) });
  });
  app.get('/external-context/akb/:installationId/pages/:pageId', async (context) => {
    const actor = options.actor(context);
    const query = z.strictObject({ projectId: z.string().min(1).max(200) }).parse(context.req.query());
    return context.json({ page: await options.service.read(actor, query.projectId,
      context.req.param('installationId'), context.req.param('pageId')) });
  });
  app.post('/tasks/:taskId/external-context/akb', async (context) => {
    const actor = options.actor(context);
    const body = akbCaptureSchema.parse(await context.req.json<unknown>());
    const reference = await options.service.capture(actor, { taskId: context.req.param('taskId'), ...body });
    return context.json({ reference }, 201);
  });
  return app;
}
