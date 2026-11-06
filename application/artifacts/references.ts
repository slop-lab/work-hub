import { z } from 'zod';
import { akbContextRequestSchema, akbSourceReferenceSchema } from '../connectors/akb/schema.ts';
import { requireProject, type Actor } from '../domain/authorization.ts';
import { forbidden, invalid } from '../domain/errors.ts';
import type { Store } from '../persistence/database.ts';
import { digest, newId, parseJson } from '../persistence/codec.ts';
import { JsonValueSchema } from '../contracts/common.ts';

export const referenceInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), title: z.string().min(1).max(500), content: z.string().min(1).max(131072) }),
  z.strictObject({ kind: z.literal('link'), title: z.string().min(1).max(500), url: z.url().max(4096) }),
]);
const rowSchema = z.object({ id: z.string(), taskId: z.string(), kind: z.enum(['text', 'link']), title: z.string(), mimeType: z.string(), provenanceJson: z.string(), locatorJson: z.string().nullable(), retainedText: z.string().nullable(), availability: z.string(), contentRevision: z.string().nullable(), createdAt: z.string() });
export const externalCaptureSelectionSchema = z.strictObject({
  commandId: z.string().min(1).max(200), taskId: z.string().min(1),
  installationId: z.string().min(1).max(200), pageId: z.string().min(1).max(200),
  revision: z.number().int().positive(),
});
export const externalCaptureSchema = externalCaptureSelectionSchema.extend({
  title: z.string().min(1).max(500), retainedText: z.string().max(131072),
  mimeType: z.string().min(1).max(200), sourceRevision: z.string().min(1).max(500),
  provenance: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const externalContextCaptureSelectionSchema = z.strictObject({
  commandId: z.string().min(1).max(200),
  taskId: z.string().min(1),
  installationId: z.string().min(1).max(200),
  contextRequest: akbContextRequestSchema,
});

const externalContextSourceSchema = akbSourceReferenceSchema.extend({
  schemaVersion: z.union([z.string().min(1).max(200), z.number().int().nonnegative()]),
  revisionCreatedAt: z.iso.datetime(),
  title: z.string().min(1).max(500),
  canonicalData: JsonValueSchema,
});

export const externalContextCaptureSchema = externalContextCaptureSelectionSchema.extend({
  contentBytes: z.number().int().nonnegative().max(256 * 1024),
  sourceWorkspaceId: z.string().min(1).max(200).optional(),
  contextDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  sources: z.array(externalContextSourceSchema).min(1).max(25).readonly(),
}).superRefine((capture, context) => {
  const sourceKeys = new Set(capture.sources.map((source) => `${source.kind}\u0000${source.id}\u0000${source.revision}`));
  if (sourceKeys.size !== capture.sources.length) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'Captured AKB sources must be unique.' });
  }
  if (capture.contentBytes > capture.contextRequest.maxBytes) {
    context.addIssue({ code: 'custom', path: ['contentBytes'], message: 'AKB context exceeds the selected byte budget.' });
  }
  const retainedBytes = Buffer.byteLength(JSON.stringify(capture.sources.map((source) => source.canonicalData)));
  if (retainedBytes > capture.contextRequest.maxBytes) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'Retained AKB canonical data exceeds the selected byte budget.' });
  }
  if ('references' in capture.contextRequest) {
    const requested = new Set(capture.contextRequest.references.map((reference) =>
      `${reference.kind}\u0000${reference.id}\u0000${reference.revision}`));
    if (requested.size !== sourceKeys.size || [...requested].some((key) => !sourceKeys.has(key))) {
      context.addIssue({ code: 'custom', path: ['sources'],
        message: 'AKB returned sources that do not match the explicit context selection.' });
    }
  }
});
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
    this.store.database.prepare(`INSERT INTO references_store(
      id,workspace_id,task_id,kind,title,mime_type,provenance_json,locator_json,retained_text,
      availability,content_revision,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, actor.workspaceId, input.taskId, reference.kind, reference.title,
      reference.kind === 'text' ? 'text/plain' : 'text/uri-list',
      JSON.stringify({ origin: 'human_assertion', authorId: actor.id, retainedByHub: reference.kind === 'text', fetchedByHub: false }),
      reference.kind === 'link' ? JSON.stringify({ url: reference.url }) : null,
      reference.kind === 'text' ? reference.content : null,
      reference.kind === 'text' ? 'available' : 'unverified',
      digest(reference.kind === 'text' ? reference.content : reference.url), now, now,
    );
    return { kind: 'reference', id, revision: 1 };
  }
  assertExternalCaptureAccess(actor: Actor, taskId: string): void {
    const task = this.store.database.prepare('SELECT project_id AS projectId FROM tasks WHERE workspace_id=? AND id=?')
      .get(actor.workspaceId, taskId);
    if (!task) throw invalid('not_found', 'Task not found.');
    requireProject(actor, z.object({ projectId: z.string() }).parse(task).projectId);
    if (actor.role === 'runtime') throw forbidden('Runtime references require a separately scoped artifact ingestion capability.');
  }
  captureExternal(actor: Actor, input: z.infer<typeof externalCaptureSchema>) {
    const capture = externalCaptureSchema.parse(input);
    this.assertExternalCaptureAccess(actor, capture.taskId);
    const id = newId('reference');
    const now = this.store.clock.now().toISOString();
    this.store.database.prepare(`INSERT INTO references_store(
      id,workspace_id,task_id,kind,title,mime_type,provenance_json,locator_json,retained_text,
      availability,content_revision,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, actor.workspaceId, capture.taskId, 'text', capture.title, capture.mimeType,
      JSON.stringify({ ...capture.provenance, retainedByHub: true, contentDigest: digest(capture.retainedText) }), null, capture.retainedText,
      'available', capture.sourceRevision, now, now,
    );
    return { kind: 'reference' as const, id, revision: 1 as const };
  }
  captureExternalContext(actor: Actor, input: z.infer<typeof externalContextCaptureSchema>) {
    const capture = externalContextCaptureSchema.parse(input);
    this.assertExternalCaptureAccess(actor, capture.taskId);
    const now = this.store.clock.now().toISOString();
    return capture.sources.map((source) => {
      const retainedText = JSON.stringify(source.canonicalData);
      const id = newId('reference');
      this.store.database.prepare(`INSERT INTO references_store(
        id,workspace_id,task_id,kind,title,mime_type,provenance_json,locator_json,retained_text,
        availability,content_revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, actor.workspaceId, capture.taskId, 'text', source.title, 'application/json',
        JSON.stringify({ provider: 'akb', installationId: capture.installationId, kind: source.kind,
          id: source.id, revision: source.revision, schemaVersion: source.schemaVersion,
          sourceWorkspaceId: capture.sourceWorkspaceId, contextDigest: capture.contextDigest,
          revisionCreatedAt: source.revisionCreatedAt, retainedByHub: true, contentDigest: digest(retainedText) }),
        null, retainedText, 'available', String(source.revision), now, now,
      );
      return { kind: 'reference' as const, id, revision: 1 as const };
    });
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
