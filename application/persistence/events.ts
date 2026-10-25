import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Actor } from '../domain/authorization.ts';
import { conflict } from '../domain/errors.ts';
import { parseJson } from './codec.ts';

const rowSchema = z.object({ sequence: z.number(), actorId: z.string(), action: z.string(), targetKind: z.string().nullable(), targetId: z.string().nullable(), commandId: z.string().nullable(), operationId: z.string().nullable(), summaryJson: z.string(), createdAt: z.string() });
export class EventRepository {
  readonly database: DatabaseSync;
  constructor(database: DatabaseSync) { this.database = database; }
  list(actor: Actor, input: { readonly after: number; readonly limit: number; readonly permittedIds: ReadonlySet<string> }) {
    const bounds = z.object({ first: z.number(), last: z.number() }).parse(this.database.prepare('SELECT COALESCE(MIN(sequence),0) AS first,COALESCE(MAX(sequence),0) AS last FROM audit_entries WHERE workspace_id=?').get(actor.workspaceId));
    if (input.after > bounds.last || (input.after > 0 && input.after < bounds.first - 1)) throw conflict('event_cursor_reset_required', 'History is outside the retained event range. Reload /api/v1/state before subscribing.');
    const rows = this.database.prepare('SELECT sequence,actor_id AS actorId,action,target_kind AS targetKind,target_id AS targetId,command_id AS commandId,operation_id AS operationId,summary_json AS summaryJson,created_at AS createdAt FROM audit_entries WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(actor.workspaceId, input.after, input.limit).map((raw) => rowSchema.parse(raw));
    const items = rows.filter((row) => actor.role === 'administrator' || row.actorId === actor.id || (row.targetId !== null && input.permittedIds.has(row.targetId))).map((row) => {
      const summary = z.object({ objectRefs: z.array(z.object({ kind: z.string(), id: z.string(), revision: z.number().optional() })).optional(), status: z.string().optional(), effect: z.string().nullable().optional() }).parse(parseJson(row.summaryJson));
      const reference = summary.objectRefs?.[0];
      return { id: String(row.sequence), contractMajor: 1, type: row.action, objectKind: row.targetKind ?? reference?.kind ?? 'command', objectId: row.targetId ?? reference?.id ?? row.commandId ?? String(row.sequence), ...(reference?.revision === undefined ? {} : { revision: reference.revision }), committedAt: row.createdAt, ...(row.commandId ? { commandId: row.commandId } : {}), ...(row.operationId ? { operationId: row.operationId } : {}), status: summary.status ?? 'observed' };
    });
    return { items, nextCursor: String(rows.at(-1)?.sequence ?? input.after), snapshotCursor: String(bounds.last) };
  }
}
