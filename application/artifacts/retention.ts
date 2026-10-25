import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { requireAdministrator, type Actor } from '../domain/authorization.ts';
import { newId, type Clock } from '../persistence/codec.ts';

export const retentionLimits = z.strictObject({ maxBytes: z.number().int().min(65536).max(104857600), maxAgeDays: z.number().int().min(1).max(3650) });
type RetentionLimits = z.infer<typeof retentionLimits>;
function configuredLimits(): RetentionLimits {
  return retentionLimits.parse({ maxBytes: Number(process.env['OUTPUT_RETENTION_BYTES'] ?? '1048576'), maxAgeDays: Number(process.env['OUTPUT_RETENTION_DAYS'] ?? '30') });
}
const rowSchema = z.object({ first: z.number().nullable(), last: z.number().nullable(), count: z.number(), bytes: z.number() });
export class OutputRetention {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  readonly limits: RetentionLimits;
  constructor(database: DatabaseSync, clock: Clock, limits: RetentionLimits = configuredLimits()) {
    this.database = database; this.clock = clock; this.limits = retentionLimits.parse(limits);
    database.exec('CREATE TABLE IF NOT EXISTS output_retention(session_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,gap_id TEXT NOT NULL,first_pruned INTEGER NOT NULL,last_pruned INTEGER NOT NULL,pruned_count INTEGER NOT NULL,pruned_bytes INTEGER NOT NULL,updated_at TEXT NOT NULL)');
  }
  applySession(scope: { readonly workspaceId: string; readonly sessionId: string }): number {
    const cutoff = new Date(this.clock.now().getTime() - this.limits.maxAgeDays * 86400000).toISOString();
    const candidates = `WITH ranked AS (SELECT id,local_sequence,created_at,length(CAST(item_json AS BLOB)) AS bytes,SUM(length(CAST(item_json AS BLOB))) OVER(ORDER BY local_sequence DESC) AS cumulative FROM output_chunks WHERE workspace_id=? AND session_id=? AND json_extract(item_json,'$.kind')!='gap') SELECT id,local_sequence,bytes FROM ranked WHERE cumulative>? OR created_at<?`;
    const params = [scope.workspaceId, scope.sessionId, this.limits.maxBytes, cutoff] as const;
    const pruned = rowSchema.parse(this.database.prepare(`SELECT MIN(local_sequence) AS first,MAX(local_sequence) AS last,COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM (${candidates})`).get(...params));
    if (pruned.count === 0 || pruned.first === null || pruned.last === null) return 0;
    this.database.prepare(`DELETE FROM output_chunks WHERE id IN (SELECT id FROM (${candidates}))`).run(...params);
    const now = this.clock.now().toISOString();
    const gapId = newId('retention-gap');
    this.database.prepare(`INSERT INTO output_retention VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET first_pruned=MIN(first_pruned,excluded.first_pruned),last_pruned=MAX(last_pruned,excluded.last_pruned),pruned_count=pruned_count+excluded.pruned_count,pruned_bytes=pruned_bytes+excluded.pruned_bytes,updated_at=excluded.updated_at`).run(scope.sessionId, scope.workspaceId, gapId, pruned.first, pruned.last, pruned.count, pruned.bytes, now);
    const gap = z.object({ gapId: z.string(), count: z.number(), first: z.number(), last: z.number() }).parse(this.database.prepare('SELECT gap_id AS gapId,pruned_count AS count,first_pruned AS first,last_pruned AS last FROM output_retention WHERE session_id=?').get(scope.sessionId));
    const bounds = z.object({ first: z.number() }).parse(this.database.prepare('SELECT COALESCE(MIN(local_sequence),1)-1 AS first FROM output_chunks WHERE session_id=? AND id!=?').get(scope.sessionId, gap.gapId));
    const item = { kind: 'gap', role: 'runtime', text: `Output retention removed ${gap.count} chunks (local sequences ${gap.first}–${gap.last}). Canonical questions, answers and results are retained.`, observedAt: now };
    const generation = z.object({ generation: z.number() }).parse(this.database.prepare('SELECT binding_generation AS generation FROM sessions WHERE workspace_id=? AND id=?').get(scope.workspaceId, scope.sessionId)).generation;
    this.database.prepare(`INSERT INTO output_chunks(id,workspace_id,session_id,attempt_id,local_sequence,source_item_id,binding_generation,item_json,created_at) VALUES(?,?,?,NULL,?,NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET local_sequence=excluded.local_sequence,item_json=excluded.item_json`).run(gap.gapId, scope.workspaceId, scope.sessionId, bounds.first, generation, JSON.stringify(item), now);
    this.database.prepare(`INSERT INTO audit_entries(workspace_id,actor_id,action,target_kind,target_id,summary_json,created_at) VALUES(?,'service:retention','output.retained','session',?,?,?)`).run(scope.workspaceId, scope.sessionId, JSON.stringify({ status: 'confirmed', prunedCount: pruned.count, prunedBytes: pruned.bytes }), now);
    return pruned.count;
  }
  applyWorkspace(actor: Actor): number {
    requireAdministrator(actor);
    const sessions = this.database.prepare('SELECT DISTINCT session_id AS id FROM output_chunks WHERE workspace_id=?').all(actor.workspaceId).map((row) => z.object({ id: z.string() }).parse(row));
    return sessions.reduce((total, session) => total + this.applySession({ workspaceId: actor.workspaceId, sessionId: session.id }), 0);
  }
}
