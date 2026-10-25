import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Hub, Actor } from '../orchestration/hub.ts';
import type { ApiEnvironment } from './security.ts';
import { HubError } from '../domain/errors.ts';

export function eventRoutes(options: { readonly hub: Hub; readonly actor: (c: Context<ApiEnvironment>) => Actor }) {
  const app = new Hono<ApiEnvironment>();
  let subscribers = 0;
  app.get('/events', (c) => {
    const actor = options.actor(c);
    const after = z.coerce.number().int().nonnegative().parse(c.req.query('after') ?? c.req.header('Last-Event-ID') ?? '0');
    const initial = options.hub.events(actor, { after });
    if (!c.req.header('Accept')?.includes('text/event-stream')) return c.json(initial);
    if (subscribers >= 50) return c.json({ error: { code: 'event_subscriber_limit', message: 'Too many event subscriptions.' } }, 429);
    subscribers += 1;
    return streamSSE(c, async (stream) => {
      let cursor = after;
      const end = Date.now() + 30_000;
      try {
        while (!stream.aborted && Date.now() < end) {
          const current = options.hub.actorForUser(actor.id);
          if (!current) break;
          const page = options.hub.events(current, { after: cursor });
          for (const event of page.items) await stream.writeSSE({ event: 'domain', id: event.id, data: JSON.stringify(event) });
          cursor = Number(page.nextCursor);
          await stream.sleep(1000);
        }
      } catch (error) {
        if (error instanceof HubError && error.data.code === 'event_cursor_reset_required') await stream.writeSSE({ event: 'reset-required', data: JSON.stringify({ snapshotPath: '/api/v1/state' }) });
        else throw error;
      } finally { subscribers -= 1; }
    });
  });
  return app;
}
