import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { RequestView } from '../domain/model.ts';
import { invalid } from '../domain/errors.ts';
import { newId, type Clock } from './codec.ts';
import { toRequest, type NewRequest } from './request-codec.ts';

export class RequestRecords {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  constructor(database: DatabaseSync, clock: Clock) { this.database = database; this.clock = clock; }
  createRequest(input: NewRequest): RequestView {
    const id = newId('request');
    const now = this.clock.now().toISOString();
    const expiry = 'expiresAt' in input.validity && typeof input.validity.expiresAt === 'string' ? input.validity.expiresAt : null;
    this.database.prepare(`INSERT INTO requests(
      id,workspace_id,project_id,task_id,session_id,attempt_id,binding_generation,revision,kind,
      author_id,recipient_json,prompt,reason,reference_ids_json,answer_schema_json,blocking,
      validity_json,status,response_route,expires_at,supersedes_request_id,
      action_description_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?)`).run(
      id, input.workspaceId, input.projectId, input.taskId ?? null, input.sessionId ?? null,
      input.attemptId ?? null, input.bindingGeneration ?? null, input.kind, input.authorId,
      JSON.stringify(input.recipient), input.prompt, input.reason ?? null,
      JSON.stringify(input.referenceIds), JSON.stringify(input.answerSchema), input.blocking,
      JSON.stringify(input.validity), input.responseRoute, expiry, input.supersedesRequestId ?? null,
      input.actionDescription ? JSON.stringify(input.actionDescription) : null, now, now,
    );
    return this.getRequest(input.workspaceId, id);
  }
  getRequest(workspaceId: string, id: string): RequestView {
    const row = this.database.prepare('SELECT * FROM requests WHERE workspace_id=? AND id=?').get(workspaceId, id);
    if (!row) throw invalid('not_found', 'Request not found.');
    return toRequest(row);
  }
  listRequests(workspaceId: string): readonly RequestView[] { return this.database.prepare('SELECT * FROM requests WHERE workspace_id=? ORDER BY updated_at DESC,id').all(workspaceId).map(toRequest); }
  forTask(workspaceId: string, taskId: string): readonly RequestView[] { return this.database.prepare('SELECT * FROM requests WHERE workspace_id=? AND task_id=? ORDER BY updated_at DESC,id LIMIT 100').all(workspaceId, taskId).map(toRequest); }
  forSession(workspaceId: string, sessionId: string): readonly RequestView[] { return this.database.prepare('SELECT * FROM requests WHERE workspace_id=? AND session_id=? ORDER BY updated_at DESC,id LIMIT 100').all(workspaceId, sessionId).map(toRequest); }
  openRequests(workspaceId: string, limit: number): readonly RequestView[] { return this.database.prepare("SELECT * FROM requests WHERE workspace_id=? AND status='open' ORDER BY updated_at DESC,id LIMIT ?").all(workspaceId, limit).map(toRequest); }
  agentRequests(input: { readonly workspaceId: string; readonly sessionId: string; readonly attemptId: string; readonly bindingGeneration: number }) {
    return this.database.prepare(`SELECT * FROM requests WHERE workspace_id=? AND session_id=?
      AND attempt_id=? AND binding_generation=? AND status='open'
      AND json_extract(recipient_json,'$.kind')='agent_session'
      AND json_extract(recipient_json,'$.sessionId')=? ORDER BY created_at,id LIMIT 100`)
      .all(input.workspaceId, input.sessionId, input.attemptId, input.bindingGeneration, input.sessionId).map(toRequest);
  }
  changeStatus(workspaceId: string, id: string, status: 'withdrawn' | 'expired' | 'superseded'): RequestView {
    const now = this.clock.now().toISOString();
    this.database.prepare('UPDATE requests SET revision=revision+1,status=?,updated_at=? WHERE workspace_id=? AND id=?').run(status, now, workspaceId, id);
    this.database.prepare(`UPDATE deliveries SET status='suppressed',last_error_json=?,updated_at=? WHERE workspace_id=? AND request_id=? AND status IN ('pending','unknown')`).run(JSON.stringify({ code: `request_${status}` }), now, workspaceId, id);
    return this.getRequest(workspaceId, id);
  }
  reassign(workspaceId: string, id: string, recipient: object): RequestView {
    this.database.prepare('UPDATE requests SET revision=revision+1,recipient_json=?,updated_at=? WHERE workspace_id=? AND id=?').run(JSON.stringify(recipient), this.clock.now().toISOString(), workspaceId, id);
    return this.getRequest(workspaceId, id);
  }
  unresolvedBlocking(workspaceId: string, taskId: string): readonly string[] {
    return this.database.prepare(`SELECT id FROM requests WHERE workspace_id=? AND task_id=? AND blocking='before_delegate' AND status='open' ORDER BY id`).all(workspaceId, taskId).map((row) => z.object({ id: z.string() }).parse(row).id);
  }
  invalidateNativeRequest(input: { readonly workspaceId: string; readonly sessionId: string; readonly bindingGeneration: number; readonly installationId: string; readonly providerScope: string; readonly kind: string; readonly nativeId: string; readonly reason: string }): void {
    const ids = this.database.prepare(`SELECT id FROM requests
      WHERE workspace_id=? AND session_id=? AND binding_generation=?
        AND status IN ('open','answered')
        AND json_extract(validity_json,'$.nativeRequestRef.installationId')=?
        AND json_extract(validity_json,'$.nativeRequestRef.providerScope')=?
        AND json_extract(validity_json,'$.nativeRequestRef.kind')=?
        AND json_extract(validity_json,'$.nativeRequestRef.id')=?`).all(
      input.workspaceId, input.sessionId, input.bindingGeneration, input.installationId,
      input.providerScope, input.kind, input.nativeId,
    ).map((row) => z.object({ id: z.string() }).parse(row).id);
    for (const id of ids) this.changeStatus(input.workspaceId, id, 'superseded');
  }
}
