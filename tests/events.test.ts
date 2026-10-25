import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Hub } from '../application/orchestration/hub.ts';
import { AuthStore } from '../application/api/auth-store.ts';
import { createApplication } from '../application/api/app.ts';

test('application events resume after the snapshot watermark and command replay does not duplicate the event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-events-'));
  const hub = new Hub(join(root, 'hub.sqlite'));
  const auth = new AuthStore(':memory:');
  try {
    const actor = hub.actorForUser('user-admin'); assert.ok(actor);
    const token = auth.bootstrap(actor.id);
    const app = createApplication({ hub, auth, origin: 'http://localhost:3000', secureCookies: false });
    const watermark = hub.snapshot(actor).dashboard.snapshotCursor;
    const command = { commandId: 'event-task', type: 'task.create', payload: { projectId: 'project-default', title: 'Event-owned work' } };
    const created = await hub.execute(actor, command);
    await hub.execute(actor, command);
    const response = await app.request(`/api/v1/events?after=${watermark}`, { headers: { Authorization: `Bearer ${token}` } });
    const page = z.object({ items: z.array(z.object({ id: z.string(), objectId: z.string(), revision: z.number(), type: z.string() })), nextCursor: z.string() }).parse(await response.json());
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.objectId, created.objectRefs[0]?.id);
    assert.equal(page.items[0]?.revision, 1);
    assert.equal(hub.events(actor, { after: Number(page.nextCursor) }).items.length, 0);
    const reset = await app.request('/api/v1/events?after=999999', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(reset.status, 409);
  } finally { hub.close(); auth.close(); rmSync(root, { recursive: true }); }
});

test('a real SSE response carries bounded semantic events, not native credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-sse-'));
  const hub = new Hub(join(root, 'hub.sqlite'));
  const auth = new AuthStore(':memory:');
  try {
    const actor = hub.actorForUser('user-admin'); assert.ok(actor);
    const token = auth.bootstrap(actor.id);
    await hub.execute(actor, { commandId: 'sse-task', type: 'task.create', payload: { projectId: 'project-default', title: 'SSE task' } });
    const app = createApplication({ hub, auth, origin: 'http://localhost:3000', secureCookies: false });
    const response = await app.request('/api/v1/events?after=0', { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
    assert.match(response.headers.get('Content-Type') ?? '', /text\/event-stream/);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /event: domain/);
    assert.match(text, /"type":"task.create"/);
    assert.equal(text.includes(token), false);
    await reader.cancel();
  } finally { hub.close(); auth.close(); rmSync(root, { recursive: true }); }
});
