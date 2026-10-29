import type { DatabaseSync } from "node:sqlite";

import { InputSnapshotSchema } from "../contracts/index.ts";
import type {
  AttemptView,
  ExecutionProfileView,
  ResultView,
  SessionView,
  TaskView,
} from "../domain/model.ts";
import { assembleContext } from "../artifacts/snapshot-context.ts";
import type { Clock } from "./codec.ts";
import { digest, newId } from "./codec.ts";
import type { ExecutionRepository } from "./execution-repository.ts";

export class AttemptFactory {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private readonly execution: ExecutionRepository;

  constructor(database: DatabaseSync, clock: Clock, execution: ExecutionRepository) {
    this.database = database;
    this.clock = clock;
    this.execution = execution;
  }

  createAttachedSession(input: {
    readonly workspaceId: string; readonly task: TaskView; readonly profile: ExecutionProfileView;
    readonly controlMode: "observe" | "control"; readonly nativeIdentityKey: string;
  }): SessionView {
    const id = newId("session");
    const now = this.clock.now().toISOString();
    this.database.prepare(`INSERT INTO sessions
      (id, workspace_id, project_id, task_id, revision, runtime_installation_id,
       native_identity_key, lifecycle, control_mode, binding_generation, capabilities_json,
       profile_id,profile_revision,created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, 'opening', ?, 1, '{}', ?, ?, ?, ?)`).run(
      id, input.workspaceId, input.task.projectId, input.task.id,
      input.profile.runtimeInstallationId, input.nativeIdentityKey, input.controlMode,
      input.profile.id,input.profile.revision,now,now,
    );
    return this.execution.getSession(input.workspaceId, id);
  }

  createContinuation(input: {
    readonly workspaceId: string; readonly task: TaskView; readonly session: SessionView;
    readonly profile: ExecutionProfileView; readonly instruction: string;
    readonly predecessor: AttemptView; readonly context: "snapshot" | "current_task";
    readonly sourceResult?: ResultView;
  }): string {
    const id = newId("attempt");
    const now = this.clock.now().toISOString();
    const previous = input.context === "snapshot"
      ? InputSnapshotSchema.parse(input.predecessor.inputSnapshot)
      : undefined;
    const selectedReferenceIds = input.sourceResult?.referenceIds ?? previous?.selectedReferenceIds ?? [];
    const selectedResponseIds = input.sourceResult === undefined
      ? previous?.selectedResponseIds ?? []
      : [];
    const priorContext = input.context === "snapshot"
      ? previous?.contextItems ?? []
      : assembleContext(this.database, {
          workspaceId: input.workspaceId,
          taskId: input.task.id,
          selectedReferenceIds,
          selectedResponseIds: [],
        });
    const resultContext = input.sourceResult === undefined ? [] : [{
      sourceId: input.sourceResult.id,
      includedText: JSON.stringify({
        summary: input.sourceResult.summary,
        limitations: input.sourceResult.limitations,
      }),
    }];
    const snapshotBase = {
      id: newId("snapshot"), taskId: input.task.id,
      scopeRevision: input.task.scopeRevision,
      taskRevision: input.sourceResult === undefined && previous !== undefined
        ? previous.taskRevision : input.task.revision,
      profileId: input.profile.id,
      profileRevision: input.sourceResult === undefined && previous !== undefined
        ? previous.profileRevision : input.profile.revision,
      instruction: input.instruction, selectedReferenceIds, selectedResponseIds,
      contextItems: [...priorContext, ...resultContext],
      authorizedEffectKinds: input.sourceResult === undefined && previous !== undefined
        ? previous.authorizedEffectKinds.filter((effect) => input.profile.allowedEffects.includes(effect))
        : input.profile.allowedEffects,
      assembledAt: now,
    };
    const snapshot = { ...snapshotBase, digest: digest(snapshotBase) };
    this.database.prepare(`INSERT INTO attempts
      (id, workspace_id, task_id, session_id, profile_id, profile_revision, role, origin,
       phase, observation, input_snapshot_json, predecessor_id, unresolved,
       business_intent_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'primary', 'hub_started', 'queued', 'unknown', ?, ?, 1, ?, ?, ?)`)
      .run(id, input.workspaceId, input.task.id, input.session.id, input.profile.id,
        input.profile.revision, JSON.stringify(snapshot), input.predecessor.id,
        input.task.businessIntentEpoch, now, now);
    this.database.prepare(`UPDATE sessions SET active_attempt_id = ?, revision = revision + 1,
      updated_at = ? WHERE id = ?`).run(id, now, input.session.id);
    this.database.prepare(`UPDATE tasks SET primary_attempt_id = ?, status = 'active',
      revision = revision + 1, updated_at = ? WHERE id = ?`).run(id, now, input.task.id);
    return id;
  }

  createRetryHandoff(input: {
    readonly workspaceId: string;
    readonly task: TaskView;
    readonly profile: ExecutionProfileView;
    readonly predecessor: AttemptView;
    readonly context: "snapshot" | "current_task";
  }): { readonly session: SessionView; readonly attempt: AttemptView } {
    const sessionId = newId("session");
    const attemptId = newId("attempt");
    const now = this.clock.now().toISOString();
    const previous = InputSnapshotSchema.parse(input.predecessor.inputSnapshot);
    const snapshotSelection = input.context === "snapshot";
    const selectedReferenceIds = snapshotSelection ? previous.selectedReferenceIds : [];
    const selectedResponseIds = snapshotSelection ? previous.selectedResponseIds : [];
    const contextItems = snapshotSelection
      ? previous.contextItems
      : assembleContext(this.database, {
          workspaceId: input.workspaceId,
          taskId: input.task.id,
          selectedReferenceIds,
          selectedResponseIds,
        });
    const authorizedEffectKinds = snapshotSelection
      ? previous.authorizedEffectKinds.filter((effect) => input.profile.allowedEffects.includes(effect))
      : input.profile.allowedEffects;
    const snapshotBase = {
      id: newId("snapshot"),
      taskId: input.task.id,
      scopeRevision: input.task.scopeRevision,
      taskRevision: snapshotSelection ? previous.taskRevision : input.task.revision,
      profileId: input.profile.id,
      profileRevision: snapshotSelection ? previous.profileRevision : input.profile.revision,
      instruction: snapshotSelection
        ? previous.instruction
        : `${input.task.title}\n\n${input.task.description}`.trim(),
      selectedReferenceIds,
      selectedResponseIds,
      contextItems,
      authorizedEffectKinds,
      assembledAt: now,
    };
    const snapshot = { ...snapshotBase, digest: digest(snapshotBase) };
    this.database.prepare(`INSERT INTO sessions
      (id, workspace_id, project_id, task_id, revision, runtime_installation_id,
       lifecycle, control_mode, binding_generation, active_attempt_id, capabilities_json,
       predecessor_id,profile_id,profile_revision,created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 'opening', 'control', 1, ?, '{}', ?, ?, ?, ?, ?)`).run(
      sessionId, input.workspaceId, input.task.projectId, input.task.id,
      input.profile.runtimeInstallationId, attemptId, input.predecessor.sessionId,
      input.profile.id,input.profile.revision,now,now,
    );
    this.database.prepare(`INSERT INTO attempts
      (id, workspace_id, task_id, session_id, profile_id, profile_revision, role, origin,
       phase, observation, input_snapshot_json, predecessor_id, unresolved,
       business_intent_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'primary', 'hub_started', 'queued', 'unknown', ?, ?, 1, ?, ?, ?)`).run(
      attemptId, input.workspaceId, input.task.id, sessionId, input.profile.id,
      input.profile.revision, JSON.stringify(snapshot), input.predecessor.id,
      input.task.businessIntentEpoch, now, now,
    );
    this.database.prepare(`UPDATE tasks SET revision = revision + 1, status = 'active',
      primary_attempt_id = ?, updated_at = ? WHERE id = ?`).run(attemptId, now, input.task.id);
    return {
      session: this.execution.getSession(input.workspaceId, sessionId),
      attempt: this.execution.getAttempt(input.workspaceId, attemptId),
    };
  }

  createObservedAttempt(input: {
    readonly workspaceId: string; readonly task: TaskView; readonly session: SessionView;
    readonly profile: ExecutionProfileView;
  }): string {
    const id = newId("attempt");
    const now = this.clock.now().toISOString();
    const snapshot = { unknownOriginalInput: true, observedAt: now };
    this.database.prepare(`INSERT INTO attempts
      (id, workspace_id, task_id, session_id, profile_id, profile_revision, role, origin,
       phase, observation, input_snapshot_json, unresolved, business_intent_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'observed', 'attached_existing', 'observing', 'unknown', ?, 1, ?, ?, ?)`)
      .run(id, input.workspaceId, input.task.id, input.session.id, input.profile.id,
        input.profile.revision, JSON.stringify(snapshot), input.task.businessIntentEpoch, now, now);
    this.database.prepare(`UPDATE sessions SET active_attempt_id = ?, updated_at = ? WHERE id = ?`)
      .run(id, now, input.session.id);
    return id;
  }
}
