import { z } from "zod";

import type { Actor } from "../domain/authorization.ts";
import { requireProject } from "../domain/authorization.ts";
import { commandTargetId } from "../domain/commands.ts";
import { conflict, forbidden, unsupported } from "../domain/errors.ts";
import { digest } from "../persistence/codec.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import {
  authorizeSessionControl, requireBindingGeneration, requireRevision, requireRuntimeTargetScope,
} from "./guards.ts";
import type { CommandOf, CommandResult } from "./types.ts";

export class SessionExecutionHandler {
  private readonly execution: ExecutionRepository;
  private readonly operations: OperationRepository;
  private readonly state: StateRepository;

  constructor(
    execution: ExecutionRepository,
    operations: OperationRepository,
    state: StateRepository,
  ) {
    this.execution = execution;
    this.operations = operations;
    this.state = state;
  }

  takeControl(actor: Actor, command: CommandOf<"session.takeControl">): CommandResult {
    const sessionId = commandTargetId(command, "session");
    const session = this.execution.getSession(actor.workspaceId, sessionId);
    requireProject(actor, session.projectId);
    requireRevision(session.revision, command.expected?.session, "Session");
    requireBindingGeneration(session.bindingGeneration, command.expected?.bindingGeneration);
    requireRuntimeTargetScope(actor, session);
    const transfer = session.capabilities["controlTransfer"];
    if (typeof transfer !== "object" || transfer === null ||
      Reflect.get(transfer, "support") !== "supported") {
      throw unsupported("control_transfer_unsupported", "The runtime does not support control transfer.");
    }
    const operationId = this.operations.addOutbox({
      workspaceId: actor.workspaceId, commandId: command.commandId,
      workType: "runtime.requestControl", connectorKind: "runtime",
      installationId: session.runtimeInstallationId, stage: "request_control",
      targetId: sessionId, targetGeneration: session.bindingGeneration,
      payload: { sessionId, requestedActions: command.payload.requestedActions },
      inputDigest: digest({ sessionId, requestedActions: command.payload.requestedActions }),
    });
    return this.accepted("session.control.requested", "session", sessionId, operationId);
  }

  instruct(actor: Actor, command: CommandOf<"session.instruct">): CommandResult {
    const sessionId = commandTargetId(command, "session");
    const session = this.execution.getSession(actor.workspaceId, sessionId);
    authorizeSessionControl(actor, session);
    requireBindingGeneration(session.bindingGeneration, command.expected?.bindingGeneration);
    requireRuntimeTargetScope(actor, session, command.payload.attemptId);
    if (session.activeAttemptId !== command.payload.attemptId) {
      throw conflict("attempt_target_conflict", "Instruction target is not the current attempt.");
    }
    const modes = session.capabilities["activeInputModes"];
    if (!Array.isArray(modes) || !modes.includes(command.payload.mode)) {
      throw unsupported("instruction_timing_unsupported", "The requested instruction timing is unsupported.");
    }
    this.requireRuntimeAction(actor.workspaceId, session.id, "send_instruction");
    const payload = { sessionId, ...command.payload };
    const operationId = this.operations.addOutbox({
      workspaceId: actor.workspaceId, commandId: command.commandId,
      workType: "runtime.sendInstruction", connectorKind: "runtime",
      installationId: session.runtimeInstallationId, stage: "send_instruction",
      targetId: command.payload.attemptId, targetGeneration: session.bindingGeneration,
      payload, inputDigest: digest(payload),
    });
    return this.accepted("instruction.persisted", "attempt", command.payload.attemptId, operationId);
  }

  stop(actor: Actor, command: CommandOf<"attempt.stop">): CommandResult {
    const attemptId = commandTargetId(command, "attempt");
    const attempt = this.execution.getAttempt(actor.workspaceId, attemptId);
    const session = this.execution.getSession(actor.workspaceId, attempt.sessionId);
    authorizeSessionControl(actor, session);
    requireBindingGeneration(session.bindingGeneration, command.expected?.bindingGeneration);
    requireRuntimeTargetScope(actor, session, attemptId);
    if (["queued", "preparing", "opening_session"].includes(attempt.phase)) {
      this.state.requestStop(actor.workspaceId, attemptId);
      const pending = this.operations.unresolvedExecutionForTarget(actor.workspaceId, attemptId);
      if (pending === undefined) return this.confirmed("attempt.stop_fenced", "attempt", attemptId);
      const payload = { attemptId, operationIdToCancel: pending.id };
      const operationId = this.operations.addOutbox({
        workspaceId: actor.workspaceId, commandId: command.commandId,
        workType: "execution.cancelOperation", connectorKind: "execution",
        installationId: pending.installationId, stage: "cancel_preparation",
        targetId: attemptId, targetGeneration: session.bindingGeneration,
        payload, inputDigest: digest(payload),
      });
      return this.accepted("attempt.stop_fenced", "attempt", attemptId, operationId);
    }
    this.requireRuntimeAction(actor.workspaceId, session.id, "request_stop");
    this.state.requestStop(actor.workspaceId, attemptId);
    const payload = { sessionId: session.id, attemptId, ...command.payload };
    const operationId = this.operations.addOutbox({
      workspaceId: actor.workspaceId, commandId: command.commandId,
      workType: "runtime.requestStop", connectorKind: "runtime",
      installationId: session.runtimeInstallationId, stage: "request_stop",
      targetId: attemptId, targetGeneration: session.bindingGeneration,
      payload, inputDigest: digest(payload),
    });
    return this.accepted("attempt.stop_requested", "attempt", attemptId, operationId);
  }

  close(actor: Actor, command: CommandOf<"session.close">): CommandResult {
    const sessionId = commandTargetId(command, "session");
    const session = this.execution.getSession(actor.workspaceId, sessionId);
    requireProject(actor, session.projectId);
    requireRevision(session.revision, command.expected?.session, "Session");
    if (session.activeAttemptId !== undefined) {
      const attempt = this.execution.getAttempt(actor.workspaceId, session.activeAttemptId);
      if (attempt.unresolved && attempt.role === "primary") {
        throw conflict("controlled_work_unresolved", "Controlled work must be stopped or reconciled before closing.");
      }
    }
    this.state.closeSession(actor.workspaceId, sessionId);
    return this.confirmed("session.closed", "session", sessionId, session.revision + 1);
  }

  private requireRuntimeAction(
    workspaceId: string,
    sessionId: string,
    action: "send_instruction" | "request_stop",
  ): void {
    const descriptor = z.strictObject({
      controlGrant: z.strictObject({
        mode: z.union([z.literal("observe"), z.literal("control")]),
        allowedActions: z.array(z.string()), expiresAt: z.string().optional(),
      }).passthrough(),
    }).passthrough().parse(this.state.runtimeBinding(workspaceId, sessionId));
    if (descriptor.controlGrant.mode !== "control" ||
      !descriptor.controlGrant.allowedActions.includes(action)) {
      throw forbidden(`The returned runtime control grant does not allow ${action}.`);
    }
    if (descriptor.controlGrant.expiresAt !== undefined &&
      descriptor.controlGrant.expiresAt <= new Date().toISOString()) {
      throw conflict("runtime_control_expired", "The runtime control grant has expired.");
    }
  }

  private accepted(effect: string, kind: string, id: string, operationId: string): CommandResult {
    return { status: "accepted", confirmedEffect: effect, objectRefs: [{ kind, id }], operationIds: [operationId] };
  }

  private confirmed(effect: string, kind: string, id: string, revision?: number): CommandResult {
    return { status: "confirmed", confirmedEffect: effect,
      objectRefs: [{ kind, id, ...(revision === undefined ? {} : { revision }) }], operationIds: [] };
  }
}
