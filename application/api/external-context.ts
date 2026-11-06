import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { akbCaptureSchema, type AkbContextService } from '../connectors/akb/index.ts';
import { akbContextRequestSchema, akbDocumentQuerySchema } from '../connectors/akb/schema.ts';
import type { ContextCapturePort } from '../connectors/akb/service.ts';
import type { Actor } from '../domain/authorization.ts';
import type { ApiEnvironment } from './security.ts';

type ExternalContextRouteOptions = {
  readonly service: AkbContextService;
  readonly actor: (context: Context<ApiEnvironment>) => Actor;
  readonly contextCapture?: ContextCapturePort;
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
  app.get('/external-context/akb/:installationId/documents', async (context) => {
    const query = z.strictObject({ projectId: z.string().min(1).max(200), kind: z.enum(['page', 'knowledge']),
      query: z.string().max(500).default(''), limit: z.coerce.number().int().min(1).max(100).default(20),
      afterId: z.string().max(200).optional() }).parse(context.req.query());
    const { projectId, ...selection } = query;
    return context.json(await options.service.documents(options.actor(context),
      { projectId, installationId: context.req.param('installationId') }, akbDocumentQuerySchema.parse(selection)));
  });
  app.get('/external-context/akb/:installationId/pages/:pageId/revisions/:revision', async (context) => {
    const query = z.strictObject({ projectId: z.string().min(1).max(200) }).parse(context.req.query());
    return context.json({ page: await options.service.exactPage(options.actor(context),
      { projectId: query.projectId, installationId: context.req.param('installationId') },
      { id: context.req.param('pageId'), revision: z.coerce.number().int().positive().parse(context.req.param('revision')) }) });
  });
  app.get('/external-context/akb/:installationId/knowledge/:knowledgeId/revisions/:revision', async (context) => {
    const query = z.strictObject({ projectId: z.string().min(1).max(200) }).parse(context.req.query());
    return context.json(await options.service.exactKnowledge(options.actor(context),
      { projectId: query.projectId, installationId: context.req.param('installationId') },
      { id: context.req.param('knowledgeId'), revision: z.coerce.number().int().positive().parse(context.req.param('revision')) }));
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
  app.post('/tasks/:taskId/external-context/akb/context', async (context) => {
    if (options.contextCapture === undefined) return context.json({ error: { code: 'context_capture_unavailable' } }, 503);
    const body = z.strictObject({ commandId: z.string().min(1).max(200), installationId: z.string().min(1).max(200),
      contextRequest: akbContextRequestSchema }).parse(await context.req.json<unknown>());
    const references = await options.service.captureContext(options.actor(context),
      { ...body, taskId: context.req.param('taskId') }, options.contextCapture);
    return context.json({ references }, 201);
  });
  return app;
}
