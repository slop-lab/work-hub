import { z } from 'zod';
import type { Actor } from '../domain/authorization.ts';
import { forbidden } from '../domain/errors.ts';
import type { Store } from '../persistence/database.ts';

const rowSchema = z.object({ attentionKey: z.string(), readAt: z.string().nullable(), dismissedAt: z.string().nullable() });
export class ViewStateRepository {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }
  list(actor: Actor) {
    return this.store.database.prepare('SELECT attention_key AS attentionKey, read_at AS readAt, dismissed_at AS dismissedAt FROM user_view_state WHERE workspace_id=? AND user_id=?').all(actor.workspaceId, actor.id).map((row) => rowSchema.parse(row));
  }
  mark(actor: Actor, change: { readonly attentionKey: string; readonly action: 'read' | 'dismiss' }) {
    if (actor.role === 'runtime') throw forbidden('Runtime principals cannot change a human notification state.');
    const now = this.store.clock.now().toISOString();
    this.store.database.prepare(`INSERT INTO user_view_state(workspace_id,user_id,attention_key,read_at,dismissed_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,user_id,attention_key) DO UPDATE SET read_at=COALESCE(user_view_state.read_at,excluded.read_at),dismissed_at=COALESCE(user_view_state.dismissed_at,excluded.dismissed_at)`).run(actor.workspaceId, actor.id, change.attentionKey, change.action === 'read' ? now : null, change.action === 'dismiss' ? now : null);
    return { kind: 'user_view_state', id: change.attentionKey, revision: 1 };
  }
}
