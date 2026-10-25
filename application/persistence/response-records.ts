import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { RequestView } from '../domain/model.ts';
import { conflict } from '../domain/errors.ts';
import { digest, newId, parseJson, type Clock } from './codec.ts';
import type { InteractionAuthority } from './interaction-authority.ts';

export type BridgePoll = { readonly workspaceId: string; readonly sessionId?: string; readonly attemptId?: string; readonly bindingGeneration?: number; readonly after?: string };
export type BridgeAck = { readonly workspaceId: string; readonly responseId: string; readonly responseDigest: string; readonly bindingGeneration: number; readonly sessionId: string; readonly attemptId?: string };
const cursorSchema = z.object({ sequence: z.number().int().nonnegative(), sessionId: z.string(), attemptId: z.string(), generation: z.number().int() });
export class ResponseRecords {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  readonly authority: InteractionAuthority;
  constructor(input: { readonly database: DatabaseSync; readonly clock: Clock; readonly authority: InteractionAuthority }) { this.database = input.database; this.clock = input.clock; this.authority = input.authority; }
  commitResponse(input: { readonly workspaceId: string; readonly request: RequestView; readonly authorId: string; readonly answer: object }) {
    const id = newId('response');
    const now = this.clock.now().toISOString();
    const answerDigest = digest(input.answer);
    this.database.prepare('INSERT INTO responses(id,workspace_id,request_id,request_revision,author_id,answer_json,answer_digest,committed_at) VALUES(?,?,?,?,?,?,?,?)').run(id, input.workspaceId, input.request.id, input.request.revision, input.authorId, JSON.stringify(input.answer), answerDigest, now);
    this.database.prepare(`UPDATE requests SET status='answered',updated_at=? WHERE workspace_id=? AND id=?`).run(now, input.workspaceId, input.request.id);
    if (input.request.responseRoute !== 'none') this.database.prepare(`INSERT INTO deliveries(id,workspace_id,request_id,response_id,destination_generation,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)`).run(newId('delivery'), input.workspaceId, input.request.id, id, input.request.bindingGeneration ?? null, now, now);
    return { id, digest: answerDigest };
  }
  bridgeResponses(input: BridgePoll) {
    let after = 0;
    if (input.after) {
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')));
      if (cursor.sessionId !== input.sessionId || cursor.attemptId !== (input.attemptId ?? '') || cursor.generation !== input.bindingGeneration) throw conflict('cursor_scope_mismatch', 'Bridge cursor is outside this credential scope.');
      after = cursor.sequence;
    }
    const rows = this.database.prepare(`SELECT r.rowid AS sequence,r.id AS responseId,r.answer_digest AS responseDigest,r.answer_json AS answerJson,r.request_id AS requestId,r.request_revision AS requestRevision,d.destination_generation AS bindingGeneration,d.status,r.committed_at AS committedAt FROM responses r JOIN requests q ON q.id=r.request_id JOIN deliveries d ON d.response_id=r.id WHERE r.workspace_id=? AND q.response_route='bridge' AND q.session_id=? AND (? IS NULL OR q.attempt_id=?) AND d.destination_generation=? AND r.rowid>? AND d.status!='suppressed' ORDER BY r.rowid LIMIT 100`).all(input.workspaceId, input.sessionId ?? '', input.attemptId ?? null, input.attemptId ?? null, input.bindingGeneration ?? -1, after).map((raw) => z.object({ sequence: z.number(), responseId: z.string(), responseDigest: z.string(), answerJson: z.string(), requestId: z.string(), requestRevision: z.number(), bindingGeneration: z.number(), status: z.string(), committedAt: z.string() }).parse(raw));
    const items = rows.filter((row) => {
      if (this.authority.deliveryAllowed(input.workspaceId, row.requestId, row.responseId)) return true;
      this.updateDelivery(row.responseId, 'suppressed', { code: 'request_target_stale' });
      return false;
    }).map((row) => ({ responseId: row.responseId, responseDigest: row.responseDigest, answer: z.record(z.string(), z.unknown()).parse(parseJson(row.answerJson)), requestId: row.requestId, requestRevision: row.requestRevision, bindingGeneration: row.bindingGeneration, status: row.status, committedAt: row.committedAt }));
    const last = rows.at(-1);
    return { items, ...(last ? { nextCursor: Buffer.from(JSON.stringify({ sequence: last.sequence, sessionId: input.sessionId, attemptId: input.attemptId ?? '', generation: input.bindingGeneration })).toString('base64url') } : {}) };
  }
  acknowledgeBridgeResponse(input: BridgeAck): void {
    const raw = this.database.prepare('SELECT q.id AS requestId FROM responses r JOIN requests q ON q.id=r.request_id WHERE r.workspace_id=? AND r.id=? AND q.session_id=? AND (? IS NULL OR q.attempt_id=?) AND q.binding_generation=?').get(input.workspaceId, input.responseId, input.sessionId, input.attemptId ?? null, input.attemptId ?? null, input.bindingGeneration);
    if (!raw) throw conflict('bridge_scope_mismatch', 'Bridge acknowledgment is outside the credential scope.');
    const requestId = z.object({ requestId: z.string() }).parse(raw).requestId;
    if (!this.authority.deliveryAllowed(input.workspaceId, requestId, input.responseId)) throw conflict('request_target_stale', 'The response target is no longer valid.');
    const result = this.database.prepare(`UPDATE deliveries SET status='acknowledged',evidence_json=?,updated_at=? WHERE workspace_id=? AND response_id=? AND destination_generation=? AND status IN ('pending','unknown','acknowledged') AND EXISTS(SELECT 1 FROM responses r WHERE r.id=deliveries.response_id AND r.answer_digest=?)`).run(JSON.stringify({ source: 'explicit_bridge_ack', responseDigest: input.responseDigest }), this.clock.now().toISOString(), input.workspaceId, input.responseId, input.bindingGeneration, input.responseDigest);
    if (result.changes !== 1) throw conflict('bridge_ack_mismatch', 'Acknowledgment does not match this response digest.');
  }
  updateDelivery(responseId: string, status: 'acknowledged' | 'rejected' | 'unknown' | 'suppressed', evidence: object): void {
    this.database.prepare('UPDATE deliveries SET status=?,evidence_json=?,updated_at=? WHERE response_id=?').run(status, JSON.stringify(evidence), this.clock.now().toISOString(), responseId);
  }
  acknowledgeDeliveryScoped(input: Omit<BridgeAck, 'attemptId'>): void {
    this.database.prepare(`UPDATE deliveries SET status='acknowledged',evidence_json=?,updated_at=? WHERE workspace_id=? AND response_id=? AND destination_generation=? AND status IN ('pending','unknown','acknowledged') AND EXISTS(SELECT 1 FROM responses p JOIN requests q ON q.id=p.request_id WHERE p.id=deliveries.response_id AND p.answer_digest=? AND q.session_id=?)`).run(JSON.stringify({ source: 'runtime_ack', responseDigest: input.responseDigest }), this.clock.now().toISOString(), input.workspaceId, input.responseId, input.bindingGeneration, input.responseDigest, input.sessionId);
  }
}
