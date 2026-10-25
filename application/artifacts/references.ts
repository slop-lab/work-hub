import { z } from 'zod';
import { requireProject, type Actor } from '../domain/authorization.ts';
import { forbidden, invalid } from '../domain/errors.ts';
import type { Store } from '../persistence/database.ts';
import { digest, newId, parseJson } from '../persistence/codec.ts';

export const referenceInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), title: z.string().min(1).max(500), content: z.string().min(1).max(131072) }),
  z.strictObject({ kind: z.literal('link'), title: z.string().min(1).max(500), url: z.url().max(4096) }),
]);
const rowSchema = z.object({ id: z.string(), taskId: z.string(), kind: z.enum(['text', 'link']), title: z.string(), mimeType: z.string(), provenanceJson: z.string(), locatorJson: z.string().nullable(), retainedText: z.string().nullable(), availability: z.string(), contentRevision: z.string().nullable(), createdAt: z.string() });
export class ReferenceRepository {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }
  create(actor: Actor, input: { readonly taskId: string; readonly reference: z.infer<typeof referenceInput> }) {
    const task = this.store.database.prepare('SELECT project_id AS projectId FROM tasks WHERE workspace_id=? AND id=?').get(actor.workspaceId, input.taskId);
    if (!task) throw invalid('not_found', 'Task not found.');
    requireProject(actor, z.object({ projectId: z.string() }).parse(task).projectId);
    if (actor.role === 'runtime') throw forbidden('Runtime references require a separately scoped artifact ingestion capability.');
    const reference = input.reference;
    if (reference.kind === 'link') {
      const url = new URL(reference.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some((key) => /^(token|secret|api[_-]?key|password|authorization)$/i.test(key))) throw invalid('unsafe_reference_url', 'Use an HTTP(S) reference without embedded credentials. The hub never fetches it.');
    }
    const id = newId('reference');
    const now = this.store.clock.now().toISOString();
    this.store.database.prepare('INSERT INTO references_store(id,workspace_id,task_id,kind,title,mime_type,provenance_json,locator_json,retained_text,availability,content_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, actor.workspaceId, input.taskId, reference.kind, reference.title, reference.kind === 'text' ? 'text/plain' : 'text/uri-list', JSON.stringify({ origin: 'human_assertion', authorId: actor.id, retainedByHub: reference.kind === 'text', fetchedByHub: false }), reference.kind === 'link' ? JSON.stringify({ url: reference.url }) : null, reference.kind === 'text' ? reference.content : null, reference.kind === 'text' ? 'available' : 'unverified', digest(reference.kind === 'text' ? reference.content : reference.url), now, now);
    return { kind: 'reference', id, revision: 1 };
  }
  get(actor: Actor, id: string) {
    const raw = this.store.database.prepare('SELECT id,task_id AS taskId,kind,title,mime_type AS mimeType,provenance_json AS provenanceJson,locator_json AS locatorJson,retained_text AS retainedText,availability,content_revision AS contentRevision,created_at AS createdAt FROM references_store WHERE workspace_id=? AND id=?').get(actor.workspaceId, id);
    if (!raw) throw invalid('not_found', 'Reference not found.');
    const row = rowSchema.parse(raw);
    const project = z.object({ projectId: z.string() }).parse(this.store.database.prepare('SELECT project_id AS projectId FROM tasks WHERE workspace_id=? AND id=?').get(actor.workspaceId, row.taskId));
    requireProject(actor, project.projectId);
    if (actor.role === 'runtime') {
      const target = this.store.database.prepare('SELECT id FROM attempts WHERE workspace_id=? AND id=? AND task_id=? AND session_id=?').get(actor.workspaceId, actor.attemptId ?? '', row.taskId, actor.sessionId ?? '');
      if (!target) throw forbidden('The reference is outside the runtime credential scope.');
    }
    return { id: row.id, taskId: row.taskId, kind: row.kind, title: row.title, mimeType: row.mimeType, provenance: z.record(z.string(), z.json()).parse(parseJson(row.provenanceJson)), availability: row.availability, contentRevision: row.contentRevision, createdAt: row.createdAt, ...(row.retainedText !== null ? { retainedText: row.retainedText } : {}), ...(row.locatorJson ? { url: z.object({ url: z.url() }).parse(parseJson(row.locatorJson)).url } : {}) };
  }
}
