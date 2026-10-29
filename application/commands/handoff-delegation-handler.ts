import type { Actor } from "../domain/authorization.ts";
import { conflict } from "../domain/errors.ts";
import type { ExecutionProfileView, TaskView } from "../domain/model.ts";
import type { AttachedHandoffFactory } from "../persistence/attached-handoff.ts";
import { digest } from "../persistence/codec.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { HandoffPreview, HandoffRepository } from "../persistence/handoff-repository.ts";
import type { OperationRepository } from "../persistence/operation-repository.ts";
import { requireBindingGeneration, requireRevision } from "./guards.ts";
import type { CommandOf, CommandResult } from "./types.ts";

export class HandoffDelegationHandler {
  private readonly input: {
    readonly execution: ExecutionRepository;
    readonly handoffs: HandoffRepository;
    readonly attached: AttachedHandoffFactory;
    readonly operations: OperationRepository;
  };
  constructor(input: {
    readonly execution: ExecutionRepository;
    readonly handoffs: HandoffRepository;
    readonly attached: AttachedHandoffFactory;
    readonly operations: OperationRepository;
  }) { this.input = input; }

  preview(actor: Actor, task: TaskView, profile: ExecutionProfileView,
    command: CommandOf<"attempt.delegate">): HandoffPreview | undefined {
    return command.payload.handoff === undefined ? undefined : this.input.handoffs.requirePreview({
      workspaceId: actor.workspaceId, task, profile,
      previewDigest: command.payload.handoff.previewDigest,
      verification: command.payload.handoff.verification,
      recipient: command.payload.handoff.recipient,
    });
  }

  delegateAttached(input: {
    readonly actor: Actor; readonly command: CommandOf<"attempt.delegate">;
    readonly task: TaskView; readonly profile: ExecutionProfileView;
    readonly preview: HandoffPreview; readonly authorizedEffectKinds: readonly string[];
  }): CommandResult | undefined {
    if (input.preview.recipient.kind !== "attached") return undefined;
    if (input.command.payload.environment.mode !== "none") {
      throw conflict("attached_handoff_environment", "Attached-session handoff cannot select another environment.");
    }
    const recipient = input.preview.recipient;
    const session = this.input.execution.getSession(input.actor.workspaceId, recipient.sessionId);
    requireRevision(session.revision, recipient.sessionRevision, "Session");
    requireBindingGeneration(session.bindingGeneration, recipient.bindingGeneration);
    if (session.taskId !== input.task.id || session.lifecycle !== "open" ||
      session.controlMode !== "control" || session.runtimeInstallationId !== input.profile.runtimeInstallationId ||
      recipient.profileId !== input.profile.id || recipient.profileRevision !== input.profile.revision ||
      (session.activeAttemptId !== undefined &&
        this.input.execution.getAttempt(input.actor.workspaceId, session.activeAttemptId).unresolved)) {
      throw conflict("attached_session_unavailable", "Attached recipient is not an idle current control session for this task and profile.");
    }
    const attempt = this.input.attached.create({ workspaceId: input.actor.workspaceId,
      task: input.task, session, profile: input.profile, preview: input.preview,
      authorizedEffectKinds: input.authorizedEffectKinds });
    const payload = { sessionId: session.id, attemptId: attempt.id,
      inputSnapshot: attempt.inputSnapshot, workAreas: [] };
    const operationId = this.input.operations.addOutbox({ workspaceId: input.actor.workspaceId,
      commandId: input.command.commandId, workType: "runtime.startAttempt", connectorKind: "runtime",
      installationId: input.profile.runtimeInstallationId, stage: "start_attached_handoff",
      targetId: attempt.id, targetGeneration: session.bindingGeneration,
      payload, inputDigest: digest(payload) });
    return { status: "accepted", confirmedEffect: "attempt.created",
      objectRefs: [{ kind: "attempt", id: attempt.id }], operationIds: [operationId] };
  }

  bindNew(workspaceId: string, preview: HandoffPreview, attempt: Parameters<HandoffRepository["bindAttempt"]>[2]): void {
    this.input.handoffs.bindAttempt(workspaceId, preview, attempt);
  }
}
