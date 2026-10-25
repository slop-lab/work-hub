import type { Actor } from "../domain/authorization.ts";
import { commandTargetId } from "../domain/commands.ts";
import { forbidden, unsupported } from "../domain/errors.ts";
import { canonicalJson, digest } from "../persistence/codec.ts";
import type { AttemptFactory } from "../persistence/attempt-factory.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository } from "../persistence/operation-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import { authorizeTask, requireRevision } from "./guards.ts";
import { requireExistingSelection } from "./execution-selection.ts";
import type { CommandOf, CommandResult } from "./types.ts";

export class SessionAttachmentHandler {
  private readonly input: {
    readonly work: WorkRepository; readonly execution: ExecutionRepository;
    readonly attempts: AttemptFactory; readonly environments: EnvironmentRepository;
    readonly operations: OperationRepository;
    readonly requireInstallation: (
      workspaceId: string, kind: "execution" | "agent_runtime", id: string,
    ) => void;
  };

  constructor(input: SessionAttachmentHandler["input"]) { this.input = input; }

  attach(actor: Actor, command: CommandOf<"session.attach">): CommandResult {
    const taskId = commandTargetId(command, "task");
    const task = this.input.work.getTask(actor.workspaceId, taskId);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    const profile = this.input.execution.getProfile(
      actor.workspaceId, command.payload.profileId, command.expected?.profile,
    );
    requireRevision(profile.revision, command.expected?.profile, "Profile");
    this.input.requireInstallation(actor.workspaceId, "agent_runtime", profile.runtimeInstallationId);
    const environment = command.payload.environment;
    if (environment.mode === "provision") {
      throw unsupported("attached_session_provision_unsupported",
        "Attaching an existing native session requires an existing or environment-free route.");
    }
    const session = this.input.attempts.createAttachedSession({
      workspaceId: actor.workspaceId, task, profile, controlMode: command.payload.controlMode,
      nativeIdentityKey: canonicalJson(command.payload.nativeSession),
    });
    let bindingId: string | undefined;
    let installationId = profile.runtimeInstallationId;
    if (environment.mode === "existing") {
      const registration = this.input.environments.getRegistration(actor.workspaceId, environment.registrationId);
      this.input.requireInstallation(actor.workspaceId, "execution", registration.executionInstallationId);
      requireRevision(registration.revision, environment.expectedRegistrationRevision, "Registration");
      requireRevision(registration.revision, command.expected?.registration, "Registration");
      if (!registration.allowedProjectIds.includes(task.projectId) || registration.retiredAt !== undefined) {
        throw forbidden("The existing environment is not available to this project.");
      }
      requireExistingSelection({
        registration: this.input.environments.connectorRegistration(actor.workspaceId, registration.id),
        probeInput: this.input.environments.verification(actor.workspaceId, registration.id),
        selected: environment.workAreas, requestedAccess: environment.requestedAccess,
        now: new Date().toISOString(),
      });
      installationId = registration.executionInstallationId;
      bindingId = this.input.environments.createBinding({
        workspaceId: actor.workspaceId, sessionId: session.id,
        sourceKind: "registration", sourceId: registration.id,
        workAreaKeys: environment.workAreas.map((area) => area.key),
        accessMode: environment.requestedAccess,
      }).id;
    }
    const payload = {
      sessionId: session.id, nativeSession: command.payload.nativeSession,
      controlMode: command.payload.controlMode, environment,
      profileId: profile.id, profileRevision: profile.revision, taskId: task.id,
      ...(bindingId === undefined ? {} : { bindingId }),
    };
    const workType = environment.mode === "existing" ? "session.attachEnvironment" : "session.attachExisting";
    const operationId = this.input.operations.addOutbox({
      workspaceId: actor.workspaceId, commandId: command.commandId, workType,
      connectorKind: environment.mode === "existing" ? "execution" : "runtime",
      installationId, stage: environment.mode === "existing" ? "attach_environment" : "open_attached_session",
      targetId: session.id, targetGeneration: session.bindingGeneration,
      payload, inputDigest: digest(payload),
    });
    return { status: "accepted", confirmedEffect: "session.attachment.requested",
      objectRefs: [{ kind: "session", id: session.id }], operationIds: [operationId] };
  }
}
