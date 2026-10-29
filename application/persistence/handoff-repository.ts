import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { HandoffRecipientSchema, VerificationEnvelopeSchema } from "../contracts/handoff.ts";
import type { HandoffRecipient, VerificationEnvelope } from "../contracts/handoff.ts";
import { conflict, forbidden } from "../domain/errors.ts";
import type { AttemptView, ExecutionProfileView, TaskView } from "../domain/model.ts";
import { renderVerificationPrompt } from "../domain/handoff-prompt.ts";
import type { Clock } from "./codec.ts";
import { digest, newId, parseJson } from "./codec.ts";

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
});

export class HandoffRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  register(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly canonicalIdentity: string;
  }): ProjectRepository {
    const canonicalIdentity = input.canonicalIdentity.trim();
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
    readonly target: Readonly<Record<string, unknown>>;
  }): HandoffPreview {
    const repository = this.getRepository(input.workspaceId, input.repositoryId);
    if (repository.projectId !== input.task.projectId) throw forbidden("Repository is outside this task project.");
    if (repository.revision !== input.repositoryRevision ||
      input.verification.repositoryId !== repository.id ||
      input.verification.repositoryRevision !== repository.revision) {
      throw conflict("repository_revision_conflict", "Repository identity or revision is stale.");
    }
    const rendered = renderVerificationPrompt({ task: input.task, repository, verification: input.verification });
    const previewBase = {
      taskId: input.task.id, taskRevision: input.task.revision,
      profileId: input.profile.id, profileRevision: input.profile.revision,
      repository, verification: input.verification, recipient: input.recipient, target: input.target,
      promptDigest: rendered.promptDigest,
    };
    const previewDigest = digest(previewBase);
    this.database.prepare(`INSERT OR IGNORE INTO handoff_previews
      (preview_digest,workspace_id,task_id,task_revision,profile_id,profile_revision,
       repository_id,repository_revision,verification_json,recipient_json,target_json,prompt,prompt_digest,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      previewDigest, input.workspaceId, input.task.id, input.task.revision,
      input.profile.id, input.profile.revision, repository.id, repository.revision,
      JSON.stringify(input.verification), JSON.stringify(input.recipient), JSON.stringify(input.target), rendered.prompt,
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
  }): HandoffPreview {
    const preview = this.getPreview(input.workspaceId, input.previewDigest);
    const matches = preview.taskId === input.task.id && preview.taskRevision === input.task.revision &&
      preview.profileId === input.profile.id && preview.profileRevision === input.profile.revision &&
      digest(preview.verification) === digest(input.verification) &&
      digest(preview.recipient) === digest(input.recipient);
    if (!matches) throw conflict("handoff_preview_stale", "Preview source, context, profile, task, or recipient changed.");
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
      recipient_json AS recipientJson,target_json AS targetJson,attempt_id AS attemptId FROM handoff_previews
      WHERE workspace_id=? AND preview_digest=?`).get(workspaceId, previewDigest));
    return {
      previewDigest: row.previewDigest, promptDigest: row.promptDigest, prompt: row.prompt,
      taskId: row.taskId, taskRevision: row.taskRevision, profileId: row.profileId,
      profileRevision: row.profileRevision, repository: this.getRepository(workspaceId, row.repositoryId),
      verification: VerificationEnvelopeSchema.parse(parseJson(row.verificationJson)),
      recipient: HandoffRecipientSchema.parse(parseJson(row.recipientJson)),
      target: z.record(z.string(), z.unknown()).parse(parseJson(row.targetJson)),
    };
  }

  previewForAttempt(workspaceId: string, attemptId: string): HandoffPreview | undefined {
    const row = z.object({ previewDigest: z.string() }).optional().parse(this.database.prepare(
      `SELECT preview_digest AS previewDigest FROM handoff_previews WHERE workspace_id=? AND attempt_id=?`,
    ).get(workspaceId, attemptId));
    return row === undefined ? undefined : this.getPreview(workspaceId, row.previewDigest);
  }

  delivery(workspaceId: string, attemptId: string): Readonly<Record<string, unknown>> {
    return z.record(z.string(), z.unknown()).parse(this.database.prepare(`SELECT attempt_id AS attemptId,
      delivery_digest AS deliveryDigest,status,input_receipt_json AS inputReceiptJson,
      last_error_json AS lastErrorJson,updated_at AS updatedAt FROM attempt_deliveries
      WHERE workspace_id=? AND attempt_id=?`).get(workspaceId, attemptId));
  }
  deliveryOptional(workspaceId: string, attemptId: string): Readonly<Record<string, unknown>> | undefined {
    const row = this.database.prepare(`SELECT attempt_id AS attemptId,delivery_digest AS deliveryDigest,
      status,input_receipt_json AS inputReceiptJson,last_error_json AS lastErrorJson,
      updated_at AS updatedAt FROM attempt_deliveries WHERE workspace_id=? AND attempt_id=?`)
      .get(workspaceId, attemptId);
    return row === undefined ? undefined : z.record(z.string(), z.unknown()).parse(row);
  }
  acknowledge(workspaceId: string, attemptId: string, deliveryDigest: string): void {
    const delivery = this.delivery(workspaceId, attemptId);
    if (delivery["deliveryDigest"] !== deliveryDigest) {
      throw conflict("delivery_digest_mismatch", "Acknowledgment does not match the assigned delivery.");
    }
    const changed = this.database.prepare(`UPDATE attempt_deliveries SET status='acknowledged',updated_at=?
      WHERE workspace_id=? AND attempt_id=? AND status IN ('pending','delivered','unknown')`)
      .run(this.clock.now().toISOString(), workspaceId, attemptId).changes;
    if (changed !== 1 && delivery["status"] !== "acknowledged") {
      throw conflict("delivery_not_acknowledgeable", "Delivery is not awaiting acknowledgment.");
    }
  }
  recordDelivery(workspaceId: string, attemptId: string, input: {
    readonly status: "delivered" | "failed" | "unknown";
    readonly receipt?: object;
    readonly error?: object;
  }): void {
    const now = this.clock.now().toISOString();
    this.database.prepare(`UPDATE attempt_deliveries SET status=?,input_receipt_json=?,
      last_error_json=?,updated_at=? WHERE workspace_id=? AND attempt_id=?`).run(
      input.status, input.receipt === undefined ? null : JSON.stringify(input.receipt),
      input.error === undefined ? null : JSON.stringify(input.error), now, workspaceId, attemptId,
    );
  }
}
