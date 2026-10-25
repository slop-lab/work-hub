import { z } from "zod";

import type { Actor } from "../domain/authorization.ts";
import { requireBinding } from "../domain/authorization.ts";
import { commandTargetId } from "../domain/commands.ts";
import { conflict, forbidden, unsupported } from "../domain/errors.ts";
import { digest } from "../persistence/codec.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository } from "../persistence/operation-repository.ts";
import type { CommandOf, CommandResult } from "./types.ts";

export class EnvironmentLifecycleHandler {
  private readonly environments: EnvironmentRepository;
  private readonly execution: ExecutionRepository;
  private readonly operations: OperationRepository;

  constructor(
    environments: EnvironmentRepository,
    execution: ExecutionRepository,
    operations: OperationRepository,
  ) {
    this.environments = environments;
    this.execution = execution;
    this.operations = operations;
  }

  detach(actor: Actor, command: CommandOf<"environment.detach">): CommandResult {
    const bindingId = commandTargetId(command, "environment_binding");
    requireBinding(actor, bindingId);
    const binding = this.environments.getBinding(actor.workspaceId, bindingId);
    if (binding.generation !== command.expected?.bindingGeneration) {
      throw conflict("binding_generation_conflict", "Environment binding generation changed.");
    }
    if (binding.attemptId !== undefined &&
      this.execution.getAttempt(actor.workspaceId, binding.attemptId).unresolved) {
      throw conflict("controlled_work_unresolved", "Live work must be stopped or reconciled before detachment.");
    }
    this.environments.updateBindingState(actor.workspaceId, bindingId, "detaching");
    const installationId = this.environments.connectorBinding(actor.workspaceId, bindingId)
      .attachment.attachmentRef.installationId;
    const payload = { bindingId };
    const operationId = this.schedule(actor, command.commandId, {
      workType: "execution.detachAttachment", installationId, stage: "detach",
      targetId: bindingId, targetGeneration: binding.generation, payload,
    });
    return this.accepted("binding.detachment_requested", bindingId, operationId);
  }

  release(actor: Actor, command: CommandOf<"environment.release">): CommandResult {
    const bindingId = commandTargetId(command, "environment_binding");
    requireBinding(actor, bindingId);
    const binding = this.environments.getBinding(actor.workspaceId, bindingId);
    if (binding.generation !== command.expected?.bindingGeneration) {
      throw conflict("binding_generation_conflict", "Environment binding generation changed.");
    }
    if (binding.sourceKind !== "allocation" || binding.lifecycleGrant === undefined) {
      throw forbidden("Attach-only bindings cannot release an external environment.");
    }
    if (!["attached", "detached", "failed"].includes(binding.state)) {
      throw conflict("binding_release_state_invalid", "The allocation binding is not releasable in its current state.");
    }
    const details = this.environments.connectorBinding(actor.workspaceId, bindingId);
    const grant = z.strictObject({
      allowedActions: z.array(z.string()), expiresAt: z.string().optional(),
    }).passthrough().parse(binding.lifecycleGrant);
    if (!grant.allowedActions.includes("release_allocation") ||
      (grant.expiresAt !== undefined && grant.expiresAt <= new Date().toISOString())) {
      throw forbidden("The allocation lifecycle grant does not currently authorize release.");
    }
    if (binding.attemptId !== undefined &&
      this.execution.getAttempt(actor.workspaceId, binding.attemptId).unresolved) {
      throw conflict("controlled_work_unresolved", "Controlled work termination must be established before release.");
    }
    if (command.payload.operatorDecisionRef !== undefined) {
      throw unsupported("operator_recovery_unsupported", "No durable operator recovery decision contract is configured for this deployment.");
    }
    if (command.payload.preservationDecisionRef !== "preserve_references" &&
      command.payload.preservationDecisionRef !== "accept_reference_expiry") {
      throw conflict("preservation_decision_invalid", "Release requires a recorded preservation choice, not an arbitrary reference.");
    }
    if (this.environments.hasOtherActiveIdentityBinding(
      actor.workspaceId, bindingId, details.attachment.identity.native.id,
      details.attachment.identity.native.incarnation,
    )) {
      throw conflict("allocation_still_in_use", "Another active binding still uses this allocation identity.");
    }
    const installationId = details.attachment.attachmentRef.installationId;
    const controlledWorkTermination = binding.attemptId === undefined
      ? { status: "no_controlled_work" as const }
      : { status: "confirmed" as const, evidence: {
          effect: "attempt.termination_observed" as const,
          source: "state_inspection" as const,
          observedAt: this.execution.getAttempt(actor.workspaceId, binding.attemptId).updatedAt,
        } };
    this.environments.updateBindingState(actor.workspaceId, bindingId, "releasing");
    const payload = { bindingId, ...command.payload, controlledWorkTermination };
    const operationId = this.schedule(actor, command.commandId, {
      workType: "execution.releaseAllocation", installationId, stage: "release",
      targetId: bindingId, targetGeneration: binding.generation, payload,
    });
    return this.accepted("binding.release_requested", bindingId, operationId);
  }

  reconcile(actor: Actor, command: CommandOf<"operation.reconcile">): CommandResult {
    const operationId = commandTargetId(command, "operation");
    const original = this.operations.operation(actor.workspaceId, operationId);
    if (original === undefined) throw conflict("operation_not_found", "The operation is not available in this workspace.");
    const payload = { operationId };
    const queued = this.operations.addOutbox({
      workspaceId: actor.workspaceId, commandId: command.commandId,
      workType: "operation.reconcile", connectorKind: original.connectorKind,
      installationId: original.installationId, stage: "reconcile", targetId: operationId,
      payload, inputDigest: digest(payload),
    });
    return { status: "accepted", confirmedEffect: "operation.reconciliation_requested",
      objectRefs: [{ kind: "operation", id: operationId }], operationIds: [queued] };
  }

  private schedule(actor: Actor, commandId: string, input: {
    readonly workType: string; readonly installationId: string; readonly stage: string;
    readonly targetId: string; readonly targetGeneration: number; readonly payload: object;
  }): string {
    return this.operations.addOutbox({ workspaceId: actor.workspaceId, commandId,
      connectorKind: "execution", inputDigest: digest(input.payload), ...input });
  }

  private accepted(effect: string, id: string, operationId: string): CommandResult {
    return { status: "accepted", confirmedEffect: effect,
      objectRefs: [{ kind: "environment_binding", id }], operationIds: [operationId] };
  }
}
