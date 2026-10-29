import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { assembleContext } from "../artifacts/snapshot-context.ts";
import { conflict } from "../domain/errors.ts";
import type { AttemptView, TaskView } from "../domain/model.ts";
import { PromptEnvelopeSchema } from "../prompts/index.ts";
import { digest, type Clock } from "./codec.ts";
import type { HandoffPreview } from "./handoff-repository.ts";

export function preserveHandoffLineage(input: {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  readonly workspaceId: string;
  readonly sourceAttempt: AttemptView;
  readonly attempt: AttemptView;
  readonly task: TaskView;
  readonly preview: HandoffPreview;
}): void {
  const sourceScopeRevision = z.object({ scopeRevision: z.number().default(0) })
    .passthrough().parse(input.sourceAttempt.inputSnapshot).scopeRevision;
  if (sourceScopeRevision !== input.task.scopeRevision) {
    throw conflict("handoff_fresh_preview_required",
      "Task scope changed after the source handoff; create a fresh preview before continuing.");
  }
  const snapshot = z.record(z.string(), z.unknown()).parse(input.attempt.inputSnapshot);
  const envelope = PromptEnvelopeSchema.parse(JSON.parse(input.preview.prompt));
  const contextItems = assembleContext(input.database, { workspaceId: input.workspaceId,
    taskId: input.task.id, selectedReferenceIds: input.preview.selectedReferenceIds,
    selectedResponseIds: input.preview.selectedResponseIds });
  const base: Record<string, unknown> = { ...snapshot, verification: input.preview.verification,
    instruction: input.preview.prompt, promptDigest: input.preview.promptDigest,
    selectedReferenceIds: input.preview.selectedReferenceIds,
    selectedResponseIds: input.preview.selectedResponseIds, contextItems,
    promptTemplate: { id: "verifier_handoff", version: 1, inputDigest: digest(envelope.input) } };
  delete base["digest"];
  const complete = { ...base, digest: digest(base) };
  const now = input.clock.now().toISOString();
  input.database.prepare(`UPDATE attempts SET input_snapshot_json=?,updated_at=?
    WHERE workspace_id=? AND id=?`).run(JSON.stringify(complete), now,
    input.workspaceId, input.attempt.id);
  input.database.prepare(`INSERT INTO handoff_attempt_lineage
    (attempt_id,workspace_id,source_attempt_id,preview_digest,created_at)
    VALUES (?,?,?,?,?)`).run(input.attempt.id, input.workspaceId, input.sourceAttempt.id,
    input.preview.previewDigest, now);
  const deliveryDigest = digest({ attemptId: input.attempt.id, inputDigest: complete.digest,
    previewDigest: input.preview.previewDigest, sourceAttemptId: input.sourceAttempt.id });
  input.database.prepare(`INSERT INTO attempt_deliveries
    (attempt_id,workspace_id,delivery_digest,status,created_at,updated_at)
    VALUES (?,?,?,'pending',?,?)`).run(input.attempt.id, input.workspaceId,
    deliveryDigest, now, now);
}
