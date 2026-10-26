import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Actor } from '../domain/authorization.ts';

const rowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.bigint(), z.null(), z.instanceof(Uint8Array)]),
);

function safeRows(rows: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] {
  return rows.map((row) => rowSchema.parse(row));
}

export class QueryRepository {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  projects(workspaceId: string): readonly Readonly<Record<string, unknown>>[] {
    return safeRows(this.database.prepare(`SELECT id, revision, name,
      default_profile_id AS defaultProfileId, archived_at AS archivedAt,
      created_at AS createdAt, updated_at AS updatedAt FROM projects
      WHERE workspace_id = ? ORDER BY name, id`).all(workspaceId));
  }

  users(workspaceId: string): readonly Readonly<Record<string, unknown>>[] {
    return safeRows(this.database.prepare(`SELECT id, display_name AS displayName, role, enabled,
      created_at AS createdAt, updated_at AS updatedAt FROM users
      WHERE workspace_id = ? ORDER BY display_name, id`).all(workspaceId));
  }

  entries(workspaceId: string): readonly Readonly<Record<string, unknown>>[] {
    return safeRows(this.database.prepare(`SELECT id, task_id AS taskId, author_id AS authorId,
      entry_type AS entryType, body_json AS bodyJson, created_at AS createdAt
      FROM task_entries WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId));
  }
  entriesForTask(workspaceId: string, taskId: string) { return safeRows(this.database.prepare(`SELECT id, task_id AS taskId, author_id AS authorId, entry_type AS entryType, body_json AS bodyJson, created_at AS createdAt FROM task_entries WHERE workspace_id=? AND task_id=? ORDER BY created_at,id LIMIT 200`).all(workspaceId, taskId)); }

  responses(workspaceId: string): readonly Readonly<Record<string, unknown>>[] {
    return safeRows(this.database.prepare(`SELECT id, request_id AS requestId,
      request_revision AS requestRevision, author_id AS authorId, answer_json AS answerJson,
      answer_digest AS answerDigest, committed_at AS committedAt FROM responses
      WHERE workspace_id = ? ORDER BY committed_at, id`).all(workspaceId));
  }
  responsesForRequests(workspaceId: string, requestIds: readonly string[]) {
    if (requestIds.length === 0) return [];
    return safeRows(this.database.prepare(`SELECT id, request_id AS requestId,
      request_revision AS requestRevision, author_id AS authorId, answer_json AS answerJson,
      answer_digest AS answerDigest, committed_at AS committedAt FROM responses
      WHERE workspace_id=? AND request_id IN (${requestIds.map(() => '?').join(',')})
      ORDER BY committed_at,id LIMIT 200`).all(workspaceId, ...requestIds));
  }

  references(workspaceId: string): readonly Readonly<Record<string, unknown>>[] {
    return safeRows(this.database.prepare(`SELECT id, task_id AS taskId, kind, title,
      mime_type AS mimeType, provenance_json AS provenanceJson, availability,
      retained_text AS retainedText, CASE WHEN kind='link' THEN json_extract(locator_json,'$.url') ELSE NULL END AS url,
      content_revision AS contentRevision, created_at AS createdAt, updated_at AS updatedAt
      FROM references_store WHERE workspace_id = ? ORDER BY updated_at DESC, id`).all(workspaceId));
  }
  referencesForTask(workspaceId: string, taskId: string) {
    return safeRows(this.database.prepare(`SELECT id, task_id AS taskId, kind, title,
      mime_type AS mimeType, provenance_json AS provenanceJson, availability,
      retained_text AS retainedText,
      CASE WHEN kind='link' THEN json_extract(locator_json,'$.url') ELSE NULL END AS url,
      content_revision AS contentRevision, created_at AS createdAt, updated_at AS updatedAt
      FROM references_store WHERE workspace_id=? AND task_id=?
      ORDER BY updated_at DESC,id LIMIT 100`).all(workspaceId, taskId));
  }

  output(workspaceId: string): readonly Readonly<Record<string, unknown>>[] {
    const rows = safeRows(this.database.prepare(`SELECT id, session_id AS sessionId,
      attempt_id AS attemptId, local_sequence AS localSequence, source_item_id AS sourceItemId,
      binding_generation AS bindingGeneration, item_json AS itemJson, created_at AS createdAt
      FROM (SELECT * FROM output_chunks WHERE workspace_id = ? ORDER BY created_at DESC,local_sequence DESC LIMIT 1000) ORDER BY session_id, local_sequence`).all(workspaceId));
    const bounds = this.database.prepare('SELECT c.session_id AS sessionId,COUNT(*) AS count,MAX(c.created_at) AS observedAt,s.binding_generation AS generation FROM output_chunks c JOIN sessions s ON s.id=c.session_id AND s.workspace_id=c.workspace_id WHERE c.workspace_id=? GROUP BY c.session_id').all(workspaceId).map((row) => z.object({ sessionId: z.string(), count: z.number(), observedAt: z.string(), generation: z.number() }).parse(row));
    const gaps = bounds
      .filter((bound) => rows.filter((row) => row['sessionId'] === bound.sessionId).length < bound.count)
      .map((bound) => ({
        id: `snapshot-gap:${bound.sessionId}`, sessionId: bound.sessionId, attemptId: null,
        localSequence: 0, sourceItemId: null, bindingGeneration: bound.generation,
        itemJson: JSON.stringify({
          kind: 'gap', role: 'runtime',
          text: 'The workspace snapshot contains only a bounded output tail. Open paginated session history to read the other retained chunks.',
          observedAt: bound.observedAt,
        }),
        createdAt: bound.observedAt,
      }));
    return [...gaps, ...rows];
  }

  outputPage(workspaceId: string, input: { readonly sessionId: string; readonly attemptId?: string; readonly after: number; readonly limit: number }) {
    const attemptClause = input.attemptId === undefined ? '' : ' AND attempt_id=?';
    const parameters = input.attemptId === undefined ? [workspaceId, input.sessionId] : [workspaceId, input.sessionId, input.attemptId];
    const bounds = z.object({ first: z.number().nullable(), last: z.number().nullable(), count: z.number(), gapCount: z.number() }).parse(this.database.prepare(`SELECT MIN(local_sequence) AS first,MAX(local_sequence) AS last,COUNT(*) AS count,COALESCE(SUM(CASE WHEN json_extract(item_json,'$.kind')='gap' THEN 1 ELSE 0 END),0) AS gapCount FROM output_chunks WHERE workspace_id=? AND session_id=?${attemptClause}`).get(...parameters));
    const rows = safeRows(this.database.prepare(`SELECT id,session_id AS sessionId,attempt_id AS attemptId,local_sequence AS localSequence,source_item_id AS sourceItemId,binding_generation AS bindingGeneration,item_json AS itemJson,created_at AS createdAt FROM output_chunks WHERE workspace_id=? AND session_id=?${attemptClause} AND local_sequence>? ORDER BY local_sequence LIMIT ?`).all(...parameters, input.after, input.limit + 1));
    return { items: rows.slice(0, input.limit), hasMore: rows.length > input.limit, retainedBounds: bounds };
  }

  operations(workspaceId: string): readonly Readonly<Record<string, unknown>>[] {
    return safeRows(this.database.prepare(`SELECT id, command_id AS commandId,
      connector_kind AS connectorKind, installation_id AS installationId,
      operation_kind AS operationKind, stage, target_id AS targetId,
      target_generation AS targetGeneration, input_digest AS inputDigest,
      status, receipt_json AS receiptJson, updated_at AS updatedAt
      FROM external_operations WHERE workspace_id = ? ORDER BY updated_at DESC, id`).all(workspaceId));
  }
  operation(workspaceId: string, id: string) { return safeRows(this.database.prepare(`SELECT id,command_id AS commandId,connector_kind AS connectorKind,installation_id AS installationId,operation_kind AS operationKind,stage,target_id AS targetId,target_generation AS targetGeneration,input_digest AS inputDigest,status,receipt_json AS receiptJson,updated_at AS updatedAt FROM external_operations WHERE workspace_id=? AND id=?`).all(workspaceId, id)); }
  operationVisible(actor: Actor, id: string): boolean {
    if (actor.role === 'administrator') return true;
    return this.database.prepare(`SELECT o.id FROM external_operations o WHERE o.workspace_id=? AND o.id=? AND (
      EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id=o.workspace_id AND t.id=o.target_id AND t.project_id IN (SELECT value FROM json_each(?)))
      OR EXISTS (SELECT 1 FROM sessions s WHERE s.workspace_id=o.workspace_id AND s.id=o.target_id AND s.project_id IN (SELECT value FROM json_each(?)))
      OR EXISTS (SELECT 1 FROM attempts a JOIN tasks t ON t.id=a.task_id AND t.workspace_id=a.workspace_id WHERE a.workspace_id=o.workspace_id AND a.id=o.target_id AND t.project_id IN (SELECT value FROM json_each(?)))
      OR EXISTS (SELECT 1 FROM environment_bindings b JOIN sessions s ON s.id=b.session_id AND s.workspace_id=b.workspace_id WHERE b.workspace_id=o.workspace_id AND b.id=o.target_id AND (s.project_id IN (SELECT value FROM json_each(?)) OR b.id IN (SELECT value FROM json_each(?))))
      OR EXISTS (SELECT 1 FROM environment_registrations r JOIN json_each(r.allowed_project_ids_json) p WHERE r.workspace_id=o.workspace_id AND r.id=o.target_id AND p.value IN (SELECT value FROM json_each(?))))`)
      .get(actor.workspaceId, id, JSON.stringify(actor.projectIds), JSON.stringify(actor.projectIds), JSON.stringify(actor.projectIds), JSON.stringify(actor.projectIds), JSON.stringify(actor.bindingIds), JSON.stringify(actor.projectIds)) !== undefined;
  }
  operationalIssues(workspaceId: string, limit: number) {
    return safeRows(this.database.prepare(`SELECT id,command_id AS commandId,
      connector_kind AS connectorKind,installation_id AS installationId,
      operation_kind AS operationKind,stage,target_id AS targetId,
      target_generation AS targetGeneration,input_digest AS inputDigest,status,
      receipt_json AS receiptJson,updated_at AS updatedAt FROM external_operations
      WHERE workspace_id=? AND status IN ('unknown','failed','rejected')
      ORDER BY updated_at DESC,id LIMIT ?`).all(workspaceId, limit));
  }

  deliveries(workspaceId: string): readonly Readonly<Record<string, unknown>>[] {
    return safeRows(this.database.prepare(`SELECT id, request_id AS requestId,
      response_id AS responseId, destination_generation AS destinationGeneration,
      operation_id AS operationId, status, evidence_json AS evidenceJson,
      last_error_json AS lastErrorJson, created_at AS createdAt, updated_at AS updatedAt
      FROM deliveries WHERE workspace_id = ? ORDER BY updated_at DESC, id`).all(workspaceId));
  }
  deliveryProblems(workspaceId: string, limit: number) {
    return safeRows(this.database.prepare(`SELECT id,request_id AS requestId,
      response_id AS responseId,destination_generation AS destinationGeneration,
      operation_id AS operationId,status,evidence_json AS evidenceJson,
      last_error_json AS lastErrorJson,created_at AS createdAt,updated_at AS updatedAt
      FROM deliveries WHERE workspace_id=? AND status IN ('unknown','rejected','suppressed')
      ORDER BY updated_at DESC,id LIMIT ?`).all(workspaceId, limit));
  }

  watermark(workspaceId: string): string {
    const row = z.strictObject({ sequence: z.number() }).parse(
      this.database.prepare(`SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM audit_entries WHERE workspace_id = ?`).get(workspaceId),
    );
    return String(row.sequence);
  }
}
