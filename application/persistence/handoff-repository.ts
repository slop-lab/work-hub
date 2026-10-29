import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { HandoffRecipientSchema, VerificationEnvelopeSchema } from "../contracts/handoff.ts";
import type { HandoffRecipient, VerificationEnvelope } from "../contracts/handoff.ts";
import { conflict, forbidden } from "../domain/errors.ts";
import type { AttemptView, ExecutionProfileView, TaskView } from "../domain/model.ts";
import { renderVerificationPrompt } from "../domain/handoff-prompt.ts";
import { assembleContext } from "../artifacts/snapshot-context.ts";
import { digest, newId, parseJson, type Clock } from "./codec.ts";
import { AttemptDeliveryRepository } from "./attempt-delivery-repository.ts";
import { LifecycleRepository } from "./lifecycle-repository.ts";
import { preserveHandoffLineage } from "./handoff-lineage.ts";

export type ProjectRepository = {
  readonly id: string;
  readonly projectId: string;
  readonly canonicalIdentity: string;
  readonly revision: number;
};

export type HandoffPreview = {
  readonly previewDigest: string;
  readonly promptDigest: string;
  readonly prompt: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly repository: ProjectRepository;
  readonly verification: VerificationEnvelope;
  readonly recipient: HandoffRecipient;
  readonly selectedReferenceIds: readonly string[];
  readonly selectedResponseIds: readonly string[];
  readonly target: Readonly<Record<string, unknown>>;
};

const repositoryRowSchema = z.strictObject({
  id: z.string(), projectId: z.string(), canonicalIdentity: z.string(), revision: z.number(),
});
const previewRowSchema = z.strictObject({
  previewDigest: z.string(), promptDigest: z.string(), prompt: z.string(), taskId: z.string(),
  taskRevision: z.number(), profileId: z.string(), profileRevision: z.number(),
  repositoryId: z.string(), repositoryRevision: z.number(), verificationJson: z.string(),
  recipientJson: z.string(), targetJson: z.string(), attemptId: z.string().nullable(),
  selectedReferenceIdsJson: z.string(), selectedResponseIdsJson: z.string(),
});

export class HandoffRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private readonly deliveries: AttemptDeliveryRepository;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database; this.clock = clock; this.deliveries = new AttemptDeliveryRepository(database, clock);
  }

  register(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly canonicalIdentity: string;
  }): ProjectRepository {
    const canonicalIdentity = input.canonicalIdentity.trim();
    if (canonicalIdentity.includes("?")) {
      throw forbidden("Repository identity must not contain credential-bearing query material.");
    }
    if (canonicalIdentity.includes("://")) {
      const url = new URL(canonicalIdentity);
      if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0) {
        throw forbidden("Repository identity must not contain embedded credentials or query material.");
      }
    }
    const existing = this.database.prepare(`SELECT id,project_id AS projectId,
      canonical_identity AS canonicalIdentity,revision FROM project_repositories
      WHERE workspace_id=? AND project_id=? AND canonical_identity=?`)
      .get(input.workspaceId, input.projectId, canonicalIdentity);
    if (existing !== undefined) return repositoryRowSchema.parse(existing);
    const now = this.clock.now().toISOString();
    const id = newId("repository");
    this.database.prepare(`INSERT INTO project_repositories
      (id,workspace_id,project_id,canonical_identity,revision,created_at,updated_at)
      VALUES (?,?,?,?,1,?,?)`).run(id, input.workspaceId, input.projectId, canonicalIdentity, now, now);
    return { id, projectId: input.projectId, canonicalIdentity, revision: 1 };
  }

  getRepository(workspaceId: string, id: string): ProjectRepository {
    return repositoryRowSchema.parse(this.database.prepare(`SELECT id,project_id AS projectId,
      canonical_identity AS canonicalIdentity,revision FROM project_repositories
      WHERE workspace_id=? AND id=?`).get(workspaceId, id));
  }
  listRepositories(workspaceId: string, projectId: string): readonly ProjectRepository[] {
    return this.database.prepare(`SELECT id,project_id AS projectId,canonical_identity AS canonicalIdentity,
      revision FROM project_repositories WHERE workspace_id=? AND project_id=? ORDER BY canonical_identity,id`)
      .all(workspaceId, projectId).map((row) => repositoryRowSchema.parse(row));
  }

  preview(input: {
    readonly workspaceId: string;
    readonly task: TaskView;
    readonly profile: ExecutionProfileView;
    readonly repositoryId: string;
    readonly repositoryRevision: number;
    readonly verification: VerificationEnvelope;
    readonly recipient: HandoffRecipient;
    readonly selectedReferenceIds: readonly string[];
    readonly selectedResponseIds: readonly string[];
    readonly target: Readonly<Record<string, unknown>>;
  }): HandoffPreview {
    const repository = this.getRepository(input.workspaceId, input.repositoryId);
    if (repository.projectId !== input.task.projectId) throw forbidden("Repository is outside this task project.");
    if (repository.revision !== input.repositoryRevision ||
      input.verification.repositoryId !== repository.id ||
      input.verification.repositoryRevision !== repository.revision) {
      throw conflict("repository_revision_conflict", "Repository identity or revision is stale.");
    }
    const lifecycle = new LifecycleRepository(this.database, this.clock).view(input.workspaceId, input.task.id);
    const contextItems = assembleContext(this.database, { workspaceId: input.workspaceId,
      taskId: input.task.id, selectedReferenceIds: input.selectedReferenceIds,
      selectedResponseIds: input.selectedResponseIds });
    const rendered = renderVerificationPrompt({ task: input.task, repository,
      verification: input.verification, amendments: lifecycle.amendments, criteria: lifecycle.criteria,
      context: contextItems.map((item) => ({ id: item.sourceId,
        text: item.includedText ?? item.omissionReason ?? "Context unavailable." })) });
    const previewBase = {
      taskId: input.task.id, taskRevision: input.task.revision,
      profileId: input.profile.id, profileRevision: input.profile.revision,
      repository, verification: input.verification, recipient: input.recipient, target: input.target,
      selectedReferenceIds: input.selectedReferenceIds,
      selectedResponseIds: input.selectedResponseIds,
      promptDigest: rendered.promptDigest,
    };
    const previewDigest = digest(previewBase);
    this.database.prepare(`INSERT OR IGNORE INTO handoff_previews
      (preview_digest,workspace_id,task_id,task_revision,profile_id,profile_revision,
        repository_id,repository_revision,verification_json,recipient_json,
        selected_reference_ids_json,selected_response_ids_json,target_json,prompt,prompt_digest,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      previewDigest, input.workspaceId, input.task.id, input.task.revision,
      input.profile.id, input.profile.revision, repository.id, repository.revision,
      JSON.stringify(input.verification), JSON.stringify(input.recipient),
      JSON.stringify(input.selectedReferenceIds), JSON.stringify(input.selectedResponseIds),
      JSON.stringify(input.target), rendered.prompt,
      rendered.promptDigest, this.clock.now().toISOString(),
    );
    return { previewDigest, ...rendered, ...previewBase };
  }

  requirePreview(input: {
    readonly workspaceId: string;
    readonly task: TaskView;
    readonly profile: ExecutionProfileView;
    readonly previewDigest: string;
    readonly verification: VerificationEnvelope;
    readonly recipient: HandoffRecipient;
    readonly selectedReferenceIds: readonly string[];
    readonly selectedResponseIds: readonly string[];
  }): HandoffPreview {
    const preview = this.getPreview(input.workspaceId, input.previewDigest);
    const matches = preview.taskId === input.task.id && preview.taskRevision === input.task.revision &&
      preview.profileId === input.profile.id && preview.profileRevision === input.profile.revision &&
      digest(preview.verification) === digest(input.verification) &&
      digest(preview.recipient) === digest(input.recipient);
    if (!matches) throw conflict("handoff_preview_stale", "Preview source, context, profile, task, or recipient changed.");
    if (digest(preview.selectedReferenceIds) !== digest(input.selectedReferenceIds) ||
      digest(preview.selectedResponseIds) !== digest(input.selectedResponseIds)) {
      throw conflict("handoff_selection_mismatch", "Delegation selections must exactly match the preview.");
    }
    return preview;
  }

  bindAttempt(workspaceId: string, preview: HandoffPreview, attempt: AttemptView): void {
    const snapshot = z.record(z.string(), z.unknown()).parse(attempt.inputSnapshot);
    const base: Record<string, unknown> = {
      ...snapshot, verification: preview.verification, promptDigest: preview.promptDigest,
    };
    delete base["digest"];
    const complete = { ...base, digest: digest(base) };
    const deliveryDigest = digest({ attemptId: attempt.id, inputDigest: complete.digest,
      previewDigest: preview.previewDigest });
    const now = this.clock.now().toISOString();
    this.database.prepare(`UPDATE attempts SET input_snapshot_json=?,updated_at=?
      WHERE workspace_id=? AND id=?`).run(JSON.stringify(complete), now, workspaceId, attempt.id);
    const changed = this.database.prepare(`UPDATE handoff_previews SET attempt_id=?
      WHERE workspace_id=? AND preview_digest=? AND attempt_id IS NULL`)
      .run(attempt.id, workspaceId, preview.previewDigest).changes;
    if (changed !== 1) throw conflict("handoff_preview_consumed", "This preview already created a handoff.");
    this.database.prepare(`INSERT INTO attempt_deliveries
      (attempt_id,workspace_id,delivery_digest,status,created_at,updated_at)
      VALUES (?,?,?,'pending',?,?)`).run(attempt.id, workspaceId, deliveryDigest, now, now);
  }

  getPreview(workspaceId: string, previewDigest: string): HandoffPreview {
    const row = previewRowSchema.parse(this.database.prepare(`SELECT preview_digest AS previewDigest,
      prompt_digest AS promptDigest,prompt,task_id AS taskId,task_revision AS taskRevision,
      profile_id AS profileId,profile_revision AS profileRevision,repository_id AS repositoryId,
      repository_revision AS repositoryRevision,verification_json AS verificationJson,
      recipient_json AS recipientJson,selected_reference_ids_json AS selectedReferenceIdsJson,
      selected_response_ids_json AS selectedResponseIdsJson,target_json AS targetJson,
      attempt_id AS attemptId FROM handoff_previews
      WHERE workspace_id=? AND preview_digest=?`).get(workspaceId, previewDigest));
    return {
      previewDigest: row.previewDigest, promptDigest: row.promptDigest, prompt: row.prompt,
      taskId: row.taskId, taskRevision: row.taskRevision, profileId: row.profileId,
      profileRevision: row.profileRevision, repository: this.getRepository(workspaceId, row.repositoryId),
      verification: VerificationEnvelopeSchema.parse(parseJson(row.verificationJson)),
      recipient: HandoffRecipientSchema.parse(parseJson(row.recipientJson)),
      selectedReferenceIds: z.array(z.string()).parse(parseJson(row.selectedReferenceIdsJson)),
      selectedResponseIds: z.array(z.string()).parse(parseJson(row.selectedResponseIdsJson)),
      target: z.record(z.string(), z.unknown()).parse(parseJson(row.targetJson)),
    };
  }
  contextDigest(input: { readonly workspaceId: string; readonly taskId: string;
    readonly selectedReferenceIds: readonly string[]; readonly selectedResponseIds: readonly string[] }): string {
    return digest(assembleContext(this.database, input));
  }

  previewForAttempt(workspaceId: string, attemptId: string): HandoffPreview | undefined {
    const row = z.object({ previewDigest: z.string() }).optional().parse(this.database.prepare(
      `SELECT preview_digest AS previewDigest FROM handoff_previews WHERE workspace_id=? AND attempt_id=?
       UNION ALL SELECT preview_digest AS previewDigest FROM handoff_attempt_lineage
       WHERE workspace_id=? AND attempt_id=? LIMIT 1`,
    ).get(workspaceId, attemptId, workspaceId, attemptId));
    return row === undefined ? undefined : this.getPreview(workspaceId, row.previewDigest);
  }

  preserveLineage(input: { readonly workspaceId: string; readonly sourceAttempt: AttemptView;
    readonly attempt: AttemptView; readonly task: TaskView }): void {
    const preview = this.previewForAttempt(input.workspaceId, input.sourceAttempt.id);
    if (preview === undefined) return;
    preserveHandoffLineage({ database: this.database, clock: this.clock, preview, ...input });
  }

  delivery(workspaceId: string, attemptId: string): Readonly<Record<string, unknown>> {
    return this.deliveries.get(workspaceId, attemptId);
  }
  deliveryOptional(workspaceId: string, attemptId: string): Readonly<Record<string, unknown>> | undefined {
    return this.deliveries.optional(workspaceId, attemptId);
  }
  acknowledge(workspaceId: string, attemptId: string, deliveryDigest: string): void {
    this.deliveries.acknowledge(workspaceId, attemptId, deliveryDigest);
  }
  recordDelivery(workspaceId: string, attemptId: string, input: {
    readonly status: "delivered" | "failed" | "unknown";
    readonly receipt?: object;
    readonly error?: object;
  }): void {
    this.deliveries.record(workspaceId, attemptId, input);
  }
}
