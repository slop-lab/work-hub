import type { DatabaseSync } from "node:sqlite";

import { assembleContext } from "../artifacts/snapshot-context.ts";
import type { AttemptView, ExecutionProfileView, SessionView, TaskView } from "../domain/model.ts";
import { PromptEnvelopeSchema } from "../prompts/index.ts";
import { digest, newId, type Clock } from "./codec.ts";
import type { ExecutionRepository } from "./execution-repository.ts";
import type { HandoffPreview, HandoffRepository } from "./handoff-repository.ts";

export class AttachedHandoffFactory {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private readonly execution: ExecutionRepository;
  private readonly handoffs: HandoffRepository;

  constructor(input: {
    readonly database: DatabaseSync;
    readonly clock: Clock;
    readonly execution: ExecutionRepository;
    readonly handoffs: HandoffRepository;
  }) {
    this.database = input.database;
    this.clock = input.clock;
    this.execution = input.execution;
    this.handoffs = input.handoffs;
  }

  create(input: {
    readonly workspaceId: string;
    readonly task: TaskView;
    readonly session: SessionView;
    readonly profile: ExecutionProfileView;
    readonly preview: HandoffPreview;
    readonly authorizedEffectKinds: readonly string[];
  }): AttemptView {
    const attemptId = newId("attempt");
    const now = this.clock.now().toISOString();
    const contextItems = assembleContext(this.database, {
      workspaceId: input.workspaceId, taskId: input.task.id,
      selectedReferenceIds: input.preview.selectedReferenceIds,
      selectedResponseIds: input.preview.selectedResponseIds,
    });
    const prompt = PromptEnvelopeSchema.parse(JSON.parse(input.preview.prompt));
    const snapshotBase = {
      id: newId("snapshot"), taskId: input.task.id, taskRevision: input.task.revision,
      scopeRevision: input.task.scopeRevision,
      profileId: input.profile.id, profileRevision: input.profile.revision,
      instruction: input.preview.prompt, selectedReferenceIds: input.preview.selectedReferenceIds,
      selectedResponseIds: input.preview.selectedResponseIds,
      contextItems, authorizedEffectKinds: input.authorizedEffectKinds, assembledAt: now,
      verification: input.preview.verification, promptDigest: input.preview.promptDigest,
      promptTemplate: { id: "verifier_handoff", version: 1, inputDigest: digest(prompt.input) },
    };
    const snapshot = { ...snapshotBase, digest: digest(snapshotBase) };
    this.database.prepare(`INSERT INTO attempts
      (id,workspace_id,task_id,session_id,profile_id,profile_revision,role,origin,
       phase,observation,input_snapshot_json,unresolved,business_intent_epoch,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'primary','attached_existing','queued','unknown',?,1,?,?,?)`).run(
      attemptId,input.workspaceId,input.task.id,input.session.id,input.profile.id,
      input.profile.revision,JSON.stringify(snapshot),input.task.businessIntentEpoch,now,now,
    );
    this.database.prepare(`UPDATE sessions SET active_attempt_id=?,revision=revision+1,
      profile_id=?,profile_revision=?,updated_at=? WHERE workspace_id=? AND id=?`).run(
      attemptId,input.profile.id,input.profile.revision,now,input.workspaceId,input.session.id,
    );
    this.database.prepare(`UPDATE tasks SET primary_attempt_id=?,status='active',revision=revision+1,
      updated_at=? WHERE workspace_id=? AND id=?`).run(attemptId,now,input.workspaceId,input.task.id);
    const attempt = this.execution.getAttempt(input.workspaceId, attemptId);
    this.handoffs.bindAttempt(input.workspaceId, input.preview, attempt);
    return this.execution.getAttempt(input.workspaceId, attemptId);
  }
}
