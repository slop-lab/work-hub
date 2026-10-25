import type { DatabaseSync } from "node:sqlite";

import type { AttemptOutcome, AttemptPhase } from "../domain/model.ts";
import type { Clock } from "./codec.ts";
import { z } from "zod";
import { digest, newId, parseJson } from "./codec.ts";
import { RuntimeState } from "./runtime-state.ts";

const runtimeDescriptorSchema = z.strictObject({
  controlGrant: z.strictObject({
    mode: z.union([z.literal("observe"), z.literal("control")]),
  }).passthrough(),
}).passthrough();

export class StateRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private readonly runtime: RuntimeState;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
    this.runtime = new RuntimeState(database, clock);
  }

  requestStop(workspaceId: string, attemptId: string): void {
    this.database.prepare(`UPDATE attempts SET stop_requested_at = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(
      this.clock.now().toISOString(), this.clock.now().toISOString(), workspaceId, attemptId,
    );
  }

  requestStopAndSchedule(input: {
    readonly workspaceId: string; readonly attemptId: string; readonly commandId: string;
  }): string {
    this.requestStop(input.workspaceId, input.attemptId);
    const target = z.strictObject({
      sessionId: z.string(), installationId: z.string(), generation: z.number(),
      descriptorJson: z.string().nullable(),
    }).parse(this.database.prepare(`SELECT a.session_id AS sessionId,
      s.runtime_installation_id AS installationId, s.binding_generation AS generation,
      b.descriptor_json AS descriptorJson FROM attempts a
      JOIN sessions s ON s.id = a.session_id AND s.workspace_id = a.workspace_id
      LEFT JOIN runtime_bindings b ON b.session_id = s.id AND b.workspace_id = s.workspace_id
      WHERE a.workspace_id = ? AND a.id = ?`).get(input.workspaceId, input.attemptId));
    if (target.descriptorJson === null) {
      const preparation = z.strictObject({
        id: z.string(), installationId: z.string(),
        connectorKind: z.union([z.literal("execution"), z.literal("runtime")]),
      }).parse(
        this.database.prepare(`SELECT id, installation_id AS installationId,
          connector_kind AS connectorKind FROM external_operations
          WHERE workspace_id = ? AND target_id = ?
            AND status IN ('accepted','running','unknown') ORDER BY updated_at DESC LIMIT 1`)
          .get(input.workspaceId, input.attemptId),
      );
      if (preparation.connectorKind === "runtime") return preparation.id;
      return this.insertStopOperation({
        workspaceId: input.workspaceId, commandId: input.commandId, attemptId: input.attemptId,
        connectorKind: "execution", installationId: preparation.installationId,
        generation: target.generation, workType: "execution.cancelOperation", stage: "cancel_preparation",
        payload: { attemptId: input.attemptId, operationIdToCancel: preparation.id },
      });
    }
    const descriptor = runtimeDescriptorSchema.extend({
      controlGrant: z.strictObject({
        id: z.string(), mode: z.literal("control"), allowedActions: z.array(z.string()),
        expiresAt: z.string().optional(),
      }).passthrough(),
    }).passthrough().parse(parseJson(target.descriptorJson));
    if (!descriptor.controlGrant.allowedActions.includes("request_stop") ||
      (descriptor.controlGrant.expiresAt !== undefined &&
        descriptor.controlGrant.expiresAt <= this.clock.now().toISOString())) {
      throw new TypeError("The active runtime grant does not authorize a stop request.");
    }
    const payload = {
      sessionId: target.sessionId, attemptId: input.attemptId, mode: "stop_work", reason: "Task status changed",
    };
    return this.insertStopOperation({
      workspaceId: input.workspaceId, commandId: input.commandId, attemptId: input.attemptId,
      connectorKind: "runtime", installationId: target.installationId, generation: target.generation,
      workType: "runtime.requestStop", stage: "request_stop", payload,
    });
  }

  private insertStopOperation(input: {
    readonly workspaceId: string; readonly commandId: string; readonly attemptId: string;
    readonly connectorKind: "execution" | "runtime"; readonly installationId: string;
    readonly generation: number; readonly workType: string; readonly stage: string;
    readonly payload: object;
  }): string {
    const operationId = newId("operation");
    const outboxId = newId("outbox");
    const now = this.clock.now().toISOString();
    this.database.prepare(`INSERT INTO external_operations
      (id, workspace_id, command_id, connector_kind, installation_id, operation_kind,
       stage, target_id, target_generation, input_digest, input_json, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`)
      .run(operationId, input.workspaceId, input.commandId, input.connectorKind, input.installationId,
        input.workType, input.stage, input.attemptId, input.generation, digest(input.payload),
        JSON.stringify(input.payload), now);
    this.database.prepare(`INSERT INTO outbox
      (id, workspace_id, operation_id, work_type, payload_json, state, next_due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(outboxId, input.workspaceId, operationId, input.workType, JSON.stringify(input.payload),
        now, now, now);
    return operationId;
  }

  stopRequested(workspaceId: string, attemptId: string): boolean {
    const row = this.database.prepare(`SELECT 1 FROM attempts WHERE workspace_id = ? AND id = ?
      AND stop_requested_at IS NOT NULL`).get(workspaceId, attemptId);
    return row !== undefined;
  }

  setAttemptPhase(workspaceId: string, attemptId: string, phase: AttemptPhase): void {
    this.database.prepare(`UPDATE attempts SET phase = ?, observation = 'fresh', updated_at = ?
      WHERE workspace_id = ? AND id = ? AND phase <> 'finished' AND unresolved = 1`).run(
      phase, this.clock.now().toISOString(), workspaceId, attemptId,
    );
  }

  finishAttempt(workspaceId: string, attemptId: string, outcome: AttemptOutcome): void {
    const now = this.clock.now().toISOString();
    const attempt = z.strictObject({
      taskId: z.string(), role: z.union([z.literal("primary"), z.literal("observed")]),
      businessIntentEpoch: z.number(), hasResult: z.number(), phase: z.string(),
    }).parse(this.database.prepare(`SELECT a.task_id AS taskId, a.role,
      a.business_intent_epoch AS businessIntentEpoch, a.phase,
      EXISTS(SELECT 1 FROM results r WHERE r.attempt_id = a.id) AS hasResult
      FROM attempts a WHERE a.workspace_id = ? AND a.id = ?`).get(workspaceId, attemptId));
    if (attempt.phase === "finished") return;
    const establishedOutcome = outcome === "ended_without_result" && attempt.hasResult === 1
      ? "result_submitted" : outcome;
    this.database.prepare(`UPDATE attempts SET phase = 'finished', outcome = ?,
      observation = 'fresh', unresolved = 0, updated_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(establishedOutcome, now, workspaceId, attemptId);
    this.database.prepare(`UPDATE reservations SET unresolved = 0, updated_at = ?
      WHERE workspace_id = ? AND owner_attempt_id = ?`).run(now, workspaceId, attemptId);
    if (establishedOutcome === "result_submitted" && attempt.role === "primary") {
      this.database.prepare(`UPDATE tasks SET status = 'review', revision = revision + 1,
        updated_at = ? WHERE workspace_id = ? AND id = ? AND primary_attempt_id = ?
        AND business_intent_epoch = ? AND status = 'active'`).run(
        now, workspaceId, attempt.taskId, attemptId, attempt.businessIntentEpoch,
      );
    }
  }

  bindRuntime(input: {
    readonly workspaceId: string; readonly sessionId: string; readonly nativeIdentityKey: string;
    readonly capabilities: object; readonly descriptor: object; readonly generation: number;
  }): void {
    this.runtime.bindRuntime(input);
  }

  closeSession(workspaceId: string, sessionId: string, observedAttemptId?: string): void {
    const now = this.clock.now().toISOString();
    if (observedAttemptId !== undefined) {
      this.database.prepare(`UPDATE attempts SET observation = 'stale',
        observation_ended_at = COALESCE(observation_ended_at, ?), updated_at = ?
        WHERE workspace_id = ? AND session_id = ? AND id = ? AND role = 'observed'
          AND unresolved = 1`).run(now, now, workspaceId, sessionId, observedAttemptId);
    }
    this.database.prepare(`UPDATE sessions SET lifecycle = 'closed', revision = revision + 1,
      updated_at = ? WHERE workspace_id = ? AND id = ?`).run(
      now, workspaceId, sessionId,
    );
  }

  attemptCanReceiveInput(workspaceId: string, attemptId: string): boolean {
    return this.database.prepare(`SELECT 1 FROM attempts WHERE workspace_id = ? AND id = ?
      AND unresolved = 1 AND phase <> 'finished'`).get(workspaceId, attemptId) !== undefined;
  }

  saveAttemptNativeExecution(workspaceId: string, attemptId: string, nativeExecutionRef: object): void {
    this.database.prepare(`UPDATE attempts SET native_execution_ref_json = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND native_execution_ref_json IS NULL`).run(
      JSON.stringify(nativeExecutionRef), this.clock.now().toISOString(), workspaceId, attemptId,
    );
  }

  attemptNativeExecution(workspaceId: string, attemptId: string):
    Readonly<Record<string, unknown>> | undefined {
    const row = z.strictObject({ nativeExecutionRefJson: z.string().nullable() }).parse(
      this.database.prepare(`SELECT native_execution_ref_json AS nativeExecutionRefJson
        FROM attempts WHERE workspace_id = ? AND id = ?`).get(workspaceId, attemptId),
    );
    return row.nativeExecutionRefJson === null ? undefined
      : z.record(z.string(), z.unknown()).parse(parseJson(row.nativeExecutionRefJson));
  }

  addReservation(input: {
    readonly workspaceId: string; readonly attemptId: string;
    readonly resourceKey: string; readonly mode: "read" | "write";
    readonly assurance: "external_enforced" | "hub_only" | "none";
  }): void {
    const now = this.clock.now().toISOString();
    this.database.prepare(`INSERT INTO reservations
      (id, workspace_id, resource_key, owner_attempt_id, mode, unresolved, assurance,
       created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(input.workspaceId, input.resourceKey, input.attemptId, input.mode,
        input.assurance, now, now);
  }

  hasUnresolvedApprovalDelivery(workspaceId: string, taskId: string): boolean {
    const row = this.database.prepare(`SELECT 1 AS present FROM deliveries d
      JOIN requests r ON r.id = d.request_id
      WHERE d.workspace_id = ? AND r.task_id = ? AND r.kind = 'approval'
        AND d.status IN ('pending','unknown') LIMIT 1`).get(workspaceId, taskId);
    return row !== undefined;
  }

  hasUnresolvedManagedRelease(workspaceId: string, taskId: string): boolean {
    return this.database.prepare(`SELECT 1 FROM environment_bindings b
      JOIN sessions s ON s.id = b.session_id WHERE b.workspace_id = ? AND s.task_id = ?
      AND b.source_kind = 'allocation' AND b.state IN ('requested','waiting','releasing','failed')
      LIMIT 1`).get(workspaceId, taskId) !== undefined;
  }

  hasUnresolvedBindingForRegistration(workspaceId: string, registrationId: string): boolean {
    const row = this.database.prepare(`SELECT 1 AS present FROM environment_bindings b
      LEFT JOIN attempts a ON a.id = b.attempt_id AND a.workspace_id = b.workspace_id
      WHERE b.workspace_id = ? AND b.source_kind = 'registration' AND b.source_id = ?
        AND (b.state NOT IN ('detached','released') OR a.unresolved = 1) LIMIT 1`).get(workspaceId, registrationId);
    return row !== undefined;
  }

  runtimeBinding(workspaceId: string, sessionId: string): Readonly<Record<string, unknown>> {
    return this.runtime.runtimeBinding(workspaceId, sessionId);
  }

  runtimeBindingRecord(workspaceId: string, sessionId: string): {
    readonly generation: number;
    readonly descriptor: Readonly<Record<string, unknown>>;
  } {
    return this.runtime.runtimeBindingRecord(workspaceId, sessionId);
  }

  saveEnvironmentAttachment(input: {
    readonly workspaceId: string; readonly bindingId: string; readonly attachment: object;
    readonly identity: object; readonly useGrant: object; readonly lifecycleGrant?: object;
  }): boolean {
    return this.runtime.saveEnvironmentAttachment(input);
  }

  saveOutput(input: {
    readonly workspaceId: string; readonly sessionId: string; readonly attemptId?: string;
    readonly bindingGeneration: number; readonly sourceItemId?: string; readonly item: object;
  }): void {
    this.runtime.saveOutput(input);
  }

  updateControlGrant(workspaceId: string, sessionId: string, descriptor: object): void {
    this.runtime.updateControlGrant(workspaceId, sessionId, descriptor);
  }

  claimInboundEvent(input: {
    readonly workspaceId: string; readonly installationId: string;
    readonly sourceEventId: string; readonly bindingGeneration: number; readonly event: object;
  }, apply: () => void = () => {}): boolean {
    return this.runtime.claimInboundEvent(input, apply);
  }

  markSessionUnreachable(workspaceId: string, sessionId: string): void {
    this.runtime.markSessionUnreachable(workspaceId, sessionId);
  }

  attemptBelongs(workspaceId: string, sessionId: string, attemptId: string): boolean {
    return this.runtime.attemptBelongs(workspaceId, sessionId, attemptId);
  }
}
