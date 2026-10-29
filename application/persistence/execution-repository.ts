import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type {
  AttemptView,
  ExecutionProfileView,
  ResultView,
  SessionView,
  TaskView,
} from "../domain/model.ts";
import { assembleContext } from "../artifacts/snapshot-context.ts";
import type { RenderedPrompt } from "../prompts/index.ts";
import type { Clock } from "./codec.ts";
import { digest, newId, parseJson } from "./codec.ts";

const objectSchema = z.record(z.string(), z.unknown());
const sessionRowSchema = z.strictObject({
  id: z.string(), workspaceId: z.string(), projectId: z.string(), taskId: z.string(),
  revision: z.number(), runtimeInstallationId: z.string(), nativeIdentityKey: z.string().nullable(),
  profileId: z.string().nullable(), profileRevision: z.number().nullable(),
  lifecycle: z.union([z.literal("opening"), z.literal("open"), z.literal("closed")]),
  controlMode: z.union([z.literal("observe"), z.literal("control")]),
  bindingGeneration: z.number(), activeAttemptId: z.string().nullable(), predecessorId: z.string().nullable(),
  capabilitiesJson: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
const attemptRowSchema = z.strictObject({
  id: z.string(), workspaceId: z.string(), taskId: z.string(), sessionId: z.string(),
  profileId: z.string(), profileRevision: z.number(),
  role: z.union([z.literal("primary"), z.literal("observed")]),
  origin: z.union([z.literal("hub_started"), z.literal("attached_existing")]),
  phase: z.union([
    z.literal("queued"), z.literal("preparing"), z.literal("opening_session"),
    z.literal("observing"), z.literal("running"), z.literal("waiting_input"), z.literal("finished"),
  ]),
  outcome: z.union([
    z.literal("result_submitted"), z.literal("failed"), z.literal("canceled"),
    z.literal("ended_without_result"),
  ]).nullable(),
  observation: z.union([
    z.literal("fresh"), z.literal("stale"), z.literal("unreachable"), z.literal("unknown"),
  ]),
  inputSnapshotJson: z.string(), predecessorId: z.string().nullable(),
  unresolved: z.number(), stopRequestedAt: z.string().nullable(), observationEndedAt: z.string().nullable(),
  interruption: z.enum([
    "paused", "awaiting_input", "provider_stop", "operator_stop", "retryable_failure", "crash", "unknown",
  ]).nullable(),
  recovery: z.enum(["none", "observe", "reconcile", "resume", "retry", "escalated"]),
  retryOrdinal: z.number(), retryLimit: z.number(), retryReason: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
const profileRowSchema = z.strictObject({
  id: z.string(), revision: z.number(), workspaceId: z.string(), label: z.string(),
  enabled: z.number(), runtimeInstallationId: z.string(), configurationJson: z.string(),
  allowedEnvironmentModesJson: z.string(), defaultEnvironmentJson: z.string(),
  requiredCapabilitiesJson: z.string(), allowedEffectsJson: z.string(),
});

function toSession(row: unknown): SessionView {
  const value = sessionRowSchema.parse(row);
  return {
    id: value.id, workspaceId: value.workspaceId, projectId: value.projectId,
    taskId: value.taskId, revision: value.revision,
    runtimeInstallationId: value.runtimeInstallationId,
    ...(value.profileId === null ? {} : { profileId: value.profileId }),
    ...(value.profileRevision === null ? {} : { profileRevision: value.profileRevision }),
    ...(value.nativeIdentityKey === null ? {} : { nativeIdentityKey: value.nativeIdentityKey }),
    lifecycle: value.lifecycle, controlMode: value.controlMode,
    bindingGeneration: value.bindingGeneration,
    ...(value.activeAttemptId === null ? {} : { activeAttemptId: value.activeAttemptId }),
    ...(value.predecessorId === null ? {} : { predecessorId: value.predecessorId }),
    capabilities: objectSchema.parse(parseJson(value.capabilitiesJson)),
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function toAttempt(row: unknown): AttemptView {
  const value = attemptRowSchema.parse(row);
  return {
    id: value.id, workspaceId: value.workspaceId, taskId: value.taskId,
    sessionId: value.sessionId, profileId: value.profileId,
    profileRevision: value.profileRevision, role: value.role, origin: value.origin,
    phase: value.phase, ...(value.outcome === null ? {} : { outcome: value.outcome }),
    observation: value.observation,
    inputSnapshot: objectSchema.parse(parseJson(value.inputSnapshotJson)),
    ...(value.predecessorId === null ? {} : { predecessorId: value.predecessorId }),
    unresolved: value.unresolved === 1,
    ...(value.interruption === null ? {} : { interruption: value.interruption }),
    recovery: value.recovery,
    retryOrdinal: value.retryOrdinal,
    retryLimit: value.retryLimit,
    ...(value.retryReason === null ? {} : { retryReason: value.retryReason }),
    ...(value.stopRequestedAt === null ? {} : { stopRequestedAt: value.stopRequestedAt }),
    ...(value.observationEndedAt === null ? {} : { observationEndedAt: value.observationEndedAt }),
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

const sessionSelect = `SELECT id, workspace_id AS workspaceId, project_id AS projectId,
  task_id AS taskId, revision, runtime_installation_id AS runtimeInstallationId,
  native_identity_key AS nativeIdentityKey, lifecycle, control_mode AS controlMode,
  profile_id AS profileId, profile_revision AS profileRevision,
  binding_generation AS bindingGeneration, active_attempt_id AS activeAttemptId, predecessor_id AS predecessorId,
  capabilities_json AS capabilitiesJson, created_at AS createdAt, updated_at AS updatedAt FROM sessions`;
const attemptSelect = `SELECT id, workspace_id AS workspaceId, task_id AS taskId,
  session_id AS sessionId, profile_id AS profileId, profile_revision AS profileRevision,
  role, origin, phase, outcome, observation, input_snapshot_json AS inputSnapshotJson,
  predecessor_id AS predecessorId,
  unresolved, stop_requested_at AS stopRequestedAt, observation_ended_at AS observationEndedAt,
  interruption_kind AS interruption, recovery_kind AS recovery,
  retry_ordinal AS retryOrdinal, retry_limit AS retryLimit, retry_reason AS retryReason,
  created_at AS createdAt,
  updated_at AS updatedAt FROM attempts`;

export class ExecutionRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  getProfile(workspaceId: string, id: string, revision?: number): ExecutionProfileView {
    const row = revision === undefined
      ? this.database.prepare(`SELECT id, revision, workspace_id AS workspaceId, label, enabled,
          runtime_installation_id AS runtimeInstallationId, configuration_json AS configurationJson,
          allowed_environment_modes_json AS allowedEnvironmentModesJson,
          default_environment_json AS defaultEnvironmentJson,
          required_capabilities_json AS requiredCapabilitiesJson,
          allowed_effects_json AS allowedEffectsJson FROM execution_profiles
          WHERE workspace_id = ? AND id = ? ORDER BY revision DESC LIMIT 1`).get(workspaceId, id)
      : this.database.prepare(`SELECT id, revision, workspace_id AS workspaceId, label, enabled,
          runtime_installation_id AS runtimeInstallationId, configuration_json AS configurationJson,
          allowed_environment_modes_json AS allowedEnvironmentModesJson,
          default_environment_json AS defaultEnvironmentJson,
          required_capabilities_json AS requiredCapabilitiesJson,
          allowed_effects_json AS allowedEffectsJson FROM execution_profiles
          WHERE workspace_id = ? AND id = ? AND revision = ?`).get(workspaceId, id, revision);
    const value = profileRowSchema.parse(row);
    return {
      id: value.id, revision: value.revision, workspaceId: value.workspaceId,
      label: value.label, enabled: value.enabled === 1,
      runtimeInstallationId: value.runtimeInstallationId,
      configuration: objectSchema.parse(parseJson(value.configurationJson)),
      allowedEnvironmentModes: z.array(z.union([
        z.literal("provision"), z.literal("existing"), z.literal("none"),
      ])).parse(parseJson(value.allowedEnvironmentModesJson)),
      defaultEnvironment: objectSchema.parse(parseJson(value.defaultEnvironmentJson)),
      requiredCapabilities: z.array(z.string()).parse(parseJson(value.requiredCapabilitiesJson)),
      allowedEffects: z.array(z.string()).parse(parseJson(value.allowedEffectsJson)),
    };
  }

  listProfiles(workspaceId: string): readonly ExecutionProfileView[] {
    const ids = this.database.prepare(`SELECT DISTINCT id FROM execution_profiles WHERE workspace_id = ?`)
      .all(workspaceId).map((row) => z.strictObject({ id: z.string() }).parse(row).id);
    return ids.map((id) => this.getProfile(workspaceId, id));
  }

  createDelegation(input: {
    readonly task: TaskView; readonly profile: ExecutionProfileView;
    readonly instruction: string; readonly selectedReferenceIds: readonly string[];
    readonly selectedResponseIds: readonly string[]; readonly authorizedEffectKinds: readonly string[];
    readonly renderInstruction?: (input: { readonly attemptId: string;
      readonly contextItems: ReturnType<typeof assembleContext> }) => RenderedPrompt<"task_brief">;
    readonly promptTemplate?: { readonly id: "verifier_handoff"; readonly version: 1; readonly inputDigest: string };
    readonly promptDigest?: string;
  }): { readonly session: SessionView; readonly attempt: AttemptView } {
    const sessionId = newId("session");
    const attemptId = newId("attempt");
    const now = this.clock.now().toISOString();
    const contextItems = assembleContext(this.database, {
      workspaceId: input.task.workspaceId,
      taskId: input.task.id,
      selectedReferenceIds: input.selectedReferenceIds,
      selectedResponseIds: input.selectedResponseIds,
    });
    const rendered = input.renderInstruction?.({ attemptId, contextItems });
    const snapshot = {
      id: newId("snapshot"), taskId: input.task.id, taskRevision: input.task.revision,
      scopeRevision: input.task.scopeRevision,
      profileId: input.profile.id, profileRevision: input.profile.revision,
      instruction: rendered?.text ?? input.instruction, selectedReferenceIds: input.selectedReferenceIds,
      selectedResponseIds: input.selectedResponseIds, authorizedEffectKinds: input.authorizedEffectKinds,
      contextItems,
      assembledAt: now,
      ...(rendered === undefined && input.promptDigest === undefined ? {} : {
        promptDigest: rendered?.digest ?? input.promptDigest }),
      ...(rendered === undefined && input.promptTemplate === undefined ? {} : {
        promptTemplate: rendered === undefined ? input.promptTemplate : {
          id: rendered.templateId, version: rendered.version, inputDigest: rendered.inputDigest } }),
    };
    const completeSnapshot = { ...snapshot, digest: digest(snapshot) };
    const predecessor = input.task.primaryAttemptId ? z.object({ sessionId: z.string() }).optional().parse(this.database.prepare('SELECT session_id AS sessionId FROM attempts WHERE workspace_id=? AND id=?').get(input.task.workspaceId, input.task.primaryAttemptId)) : undefined;
    this.database.prepare(`INSERT INTO sessions
      (id, workspace_id, project_id, task_id, revision, runtime_installation_id,
        lifecycle, control_mode, binding_generation, active_attempt_id, capabilities_json, predecessor_id,
        profile_id,profile_revision,created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, 'opening', 'control', 1, ?, '{}', ?, ?, ?, ?, ?)`)
      .run(sessionId, input.task.workspaceId, input.task.projectId, input.task.id,
        input.profile.runtimeInstallationId, attemptId, predecessor?.sessionId ?? null,
        input.profile.id,input.profile.revision,now,now);
    this.database.prepare(`INSERT INTO attempts
      (id, workspace_id, task_id, session_id, profile_id, profile_revision, role, origin,
       phase, observation, input_snapshot_json, unresolved, business_intent_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'primary', 'hub_started', 'queued', 'unknown', ?, 1, ?, ?, ?)`)
      .run(attemptId, input.task.workspaceId, input.task.id, sessionId, input.profile.id,
        input.profile.revision, JSON.stringify(completeSnapshot), input.task.businessIntentEpoch, now, now);
    this.database.prepare(`UPDATE tasks SET revision = revision + 1, status = 'active',
      primary_attempt_id = ?, updated_at = ? WHERE id = ?`).run(attemptId, now, input.task.id);
    return {
      session: this.getSession(input.task.workspaceId, sessionId),
      attempt: this.getAttempt(input.task.workspaceId, attemptId),
    };
  }

  getSession(workspaceId: string, id: string): SessionView {
    return toSession(this.database.prepare(`${sessionSelect} WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, id));
  }

  listSessions(workspaceId: string): readonly SessionView[] {
    return this.database.prepare(`${sessionSelect} WHERE workspace_id = ? ORDER BY updated_at DESC`)
      .all(workspaceId).map(toSession);
  }
  latestSession(workspaceId: string): SessionView | undefined { const row = this.database.prepare(`${sessionSelect} WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1`).get(workspaceId); return row === undefined ? undefined : toSession(row); }

  sessionsForTask(workspaceId: string, taskId: string): readonly SessionView[] {
    return this.database.prepare(`${sessionSelect} WHERE workspace_id = ? AND task_id = ? ORDER BY updated_at DESC LIMIT 100`).all(workspaceId, taskId).map(toSession);
  }

  getAttempt(workspaceId: string, id: string): AttemptView {
    return toAttempt(this.database.prepare(`${attemptSelect} WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, id));
  }

  attemptsForTask(workspaceId: string, taskId: string): readonly AttemptView[] {
    return this.database.prepare(`${attemptSelect} WHERE workspace_id = ? AND task_id = ? ORDER BY updated_at DESC LIMIT 100`).all(workspaceId, taskId).map(toAttempt);
  }

  attemptsForSession(workspaceId: string, sessionId: string): readonly AttemptView[] {
    return this.database.prepare(`${attemptSelect} WHERE workspace_id = ? AND session_id = ? ORDER BY updated_at DESC LIMIT 100`).all(workspaceId, sessionId).map(toAttempt);
  }

  activeAttempts(workspaceId: string, limit: number): readonly AttemptView[] {
    return this.database.prepare(`${attemptSelect} WHERE workspace_id = ? AND unresolved = 1 ORDER BY updated_at DESC LIMIT ?`).all(workspaceId, limit).map(toAttempt);
  }

  listAttempts(workspaceId: string): readonly AttemptView[] {
    return this.database.prepare(`${attemptSelect} WHERE workspace_id = ? ORDER BY updated_at DESC`)
      .all(workspaceId).map(toAttempt);
  }

  updateAttemptPhase(workspaceId: string, id: string, phase: AttemptView["phase"], observation = "fresh"): void {
    this.database.prepare(`UPDATE attempts SET phase = ?, observation = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(phase, observation, this.clock.now().toISOString(), workspaceId, id);
  }
}
