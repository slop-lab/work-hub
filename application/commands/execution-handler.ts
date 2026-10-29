import type { Actor } from "../domain/authorization.ts";
import { requireProfile } from "../domain/authorization.ts";
import { commandTargetId } from "../domain/commands.ts";
import { conflict, forbidden, unsupported } from "../domain/errors.ts";
import { digest } from "../persistence/codec.ts";
import type { AttemptFactory } from "../persistence/attempt-factory.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { InteractionRepository } from "../persistence/interaction-repository.ts";
import type { OperationRepository } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import type { HandoffRepository } from "../persistence/handoff-repository.ts";
import type { AttachedHandoffFactory } from "../persistence/attached-handoff.ts";
import type { LifecycleRepository } from "../persistence/lifecycle-repository.ts";
import { PromptEnvelopeSchema, renderPrompt } from "../prompts/index.ts";
import { authorizeTask, requireRevision } from "./guards.ts";
import type { CommandOf, CommandResult } from "./types.ts";
import { existingReservationKeys, requireExistingSelection } from "./execution-selection.ts";
import { SessionExecutionHandler } from "./session-execution-handler.ts";
import { EnvironmentLifecycleHandler } from "./environment-lifecycle-handler.ts";
import { SessionAttachmentHandler } from "./session-attachment-handler.ts";
import { acceptedDelegationPlan } from './delegation-plan.ts';
import { EnvironmentRegistryHandler } from './environment-registry-handler.ts';
import { HandoffDelegationHandler } from "./handoff-delegation-handler.ts";

export class ExecutionHandler {
  readonly work: WorkRepository;
  readonly execution: ExecutionRepository;
  readonly environments: EnvironmentRepository;
  readonly interactions: InteractionRepository;
  readonly operations: OperationRepository;
  readonly state: StateRepository;
  private readonly handoffDelegation: HandoffDelegationHandler;
  private readonly lifecycle: LifecycleRepository;
  readonly installationUsable: (
    workspaceId: string,
    kind: "execution" | "agent_runtime",
    id: string,
  ) => boolean;
  private readonly sessionCommands: SessionExecutionHandler; private readonly registry: EnvironmentRegistryHandler;
  readonly runtimeSupports: (installationId: string, names: readonly string[]) => boolean;
  private readonly environmentLifecycle: EnvironmentLifecycleHandler;
  private readonly sessionAttachment: SessionAttachmentHandler;

  constructor(input: {
    readonly work: WorkRepository; readonly execution: ExecutionRepository;
    readonly attempts: AttemptFactory; readonly environments: EnvironmentRepository;
    readonly interactions: InteractionRepository; readonly operations: OperationRepository;
    readonly state: StateRepository;
    readonly handoffs: HandoffRepository;
    readonly attachedHandoffs: AttachedHandoffFactory;
    readonly lifecycle: LifecycleRepository;
    readonly installationUsable: (
      workspaceId: string,
      kind: "execution" | "agent_runtime",
      id: string,
    ) => boolean;
    readonly runtimeSupports: (installationId: string, names: readonly string[]) => boolean;
  }) {
    this.work = input.work;
    this.execution = input.execution;
    this.environments = input.environments;
    this.interactions = input.interactions;
    this.operations = input.operations;
    this.state = input.state;
    this.lifecycle = input.lifecycle;
    this.handoffDelegation = new HandoffDelegationHandler({ execution: input.execution,
      handoffs: input.handoffs, attached: input.attachedHandoffs, operations: input.operations });
    this.installationUsable = input.installationUsable;
    this.runtimeSupports = input.runtimeSupports;
    this.registry = new EnvironmentRegistryHandler({ environments: input.environments, operations: input.operations, state: input.state, requireInstallation: (workspaceId, kind, id) => this.requireInstallation(workspaceId, kind, id) });
    this.sessionCommands = new SessionExecutionHandler(input.execution, input.operations, input.state);
    this.environmentLifecycle = new EnvironmentLifecycleHandler(
      input.environments,
      input.execution,
      input.operations,
    );
    this.sessionAttachment = new SessionAttachmentHandler({
      work: input.work, execution: input.execution, attempts: input.attempts,
      environments: input.environments, operations: input.operations,
      requireInstallation: (workspaceId, kind, id) => this.requireInstallation(workspaceId, kind, id),
    });
  }

  register(actor: Actor, command: CommandOf<"environment.register">): CommandResult {
    return this.registry.register(actor, command);
  }

  verify(actor: Actor, command: CommandOf<"environment.verify">): CommandResult {
    return this.registry.verify(actor, command);
  }

  retire(actor: Actor, command: CommandOf<"environment.retire">): CommandResult {
    return this.registry.retire(actor, command);
  }

  delegate(actor: Actor, command: CommandOf<"attempt.delegate">): CommandResult {
    const taskId = commandTargetId(command, "task");
    const task = this.work.getTask(actor.workspaceId, taskId);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    if (task.archivedAt || task.status === 'done' || task.status === 'canceled') throw conflict('task_not_delegable', 'Reopen an unarchived task explicitly before delegating new work.');
    requireProfile(actor, command.payload.profileId);
    const profile = this.execution.getProfile(actor.workspaceId, command.payload.profileId, command.expected?.profile);
    requireRevision(profile.revision, command.expected?.profile, "Profile");
    this.requireInstallation(actor.workspaceId, "agent_runtime", profile.runtimeInstallationId);
    if (!this.runtimeSupports(profile.runtimeInstallationId, profile.requiredCapabilities)) throw unsupported('required_capability_unavailable', 'The runtime does not support this profile’s required capabilities.');
    if (!profile.enabled || !profile.allowedEnvironmentModes.includes(command.payload.environment.mode)) {
      throw unsupported("environment_mode_unsupported", "The selected profile does not allow this environment mode.");
    }
    if (command.payload.authorizedEffectKinds.some((effect) => !profile.allowedEffects.includes(effect))) {
      throw forbidden("The command requests effects outside the selected profile grant.");
    }
    const blockers = this.interactions.unresolvedBlocking(actor.workspaceId, taskId);
    if (blockers.length > 0) {
      throw conflict("blocking_requests_open", "Delegation is blocked by unresolved requests.");
    }
    if (!this.interactions.validateSelectedResponses(
      actor.workspaceId,
      taskId,
      command.payload.selectedResponseIds,
    )) {
      throw conflict("selected_response_invalid", "Selected responses must belong to this task and remain valid.");
    }
    if (!this.work.validateSelectedReferences(
      actor.workspaceId,
      taskId,
      command.payload.selectedReferenceIds,
    )) {
      throw conflict("selected_reference_invalid", "Selected references must belong to this task and remain available.");
    }
    const unresolvedPrimaryAttemptId = task.primaryAttemptId && this.execution.getAttempt(actor.workspaceId, task.primaryAttemptId).unresolved ? task.primaryAttemptId : undefined;
    const plan = acceptedDelegationPlan({ task, profile, command, ...(unresolvedPrimaryAttemptId ? { unresolvedPrimaryAttemptId } : {}) });
    const preview = this.handoffDelegation.preview(actor, task, profile, command);
    const instruction = preview?.prompt ?? command.payload.instruction ?? plan.instruction;
    if (preview !== undefined) {
      const attached = this.handoffDelegation.delegateAttached({ actor, command, task, profile,
        preview, authorizedEffectKinds: plan.requiredEffectKinds });
      if (attached !== undefined) return attached;
    }
    const handoffEnvelope = preview === undefined ? undefined : PromptEnvelopeSchema.parse(JSON.parse(preview.prompt));
    const created = this.execution.createDelegation({
      task, profile, instruction,
      selectedReferenceIds: command.payload.selectedReferenceIds,
      selectedResponseIds: command.payload.selectedResponseIds,
      authorizedEffectKinds: plan.requiredEffectKinds,
      ...(preview === undefined ? { renderInstruction: ({ attemptId, contextItems }) => renderPrompt("task_brief", {
        task: { id: task.id, revision: task.revision, scopeRevision: task.scopeRevision,
          title: task.title, description: task.description,
          ...(task.expectedOutcome === undefined ? {} : { expectedOutcome: task.expectedOutcome }) },
        attemptId, instruction, execution: { profileId: profile.id, profileRevision: profile.revision,
          runtimeInstallationId: profile.runtimeInstallationId, environment: command.payload.environment },
        amendments: this.lifecycle.view(actor.workspaceId, task.id).amendments,
        criteria: this.lifecycle.currentCriteria(actor.workspaceId, task.id),
        context: contextItems.map((item) => ({ id: item.sourceId,
          text: item.includedText ?? item.omissionReason ?? "Context unavailable." })),
      }) } : { promptDigest: preview.promptDigest, promptTemplate: { id: "verifier_handoff", version: 1,
        inputDigest: digest(handoffEnvelope?.input ?? {}) } }),
    });
    if (preview !== undefined) this.handoffDelegation.bindNew(actor.workspaceId, preview, created.attempt);
    const environment = command.payload.environment;
    let bindingId: string | undefined;
    if (environment.mode === "existing") {
      const registration = this.environments.getRegistration(actor.workspaceId, environment.registrationId);
      this.requireInstallation(actor.workspaceId, "execution", registration.executionInstallationId);
      requireRevision(registration.revision, environment.expectedRegistrationRevision, "Registration");
      requireRevision(registration.revision, command.expected?.registration, "Registration");
      if (registration.retiredAt !== undefined || !registration.allowedProjectIds.includes(task.projectId)) {
        throw forbidden("The existing environment is not available to this project.");
      }
      requireExistingSelection({
        registration: this.environments.connectorRegistration(actor.workspaceId, registration.id),
        probeInput: this.environments.verification(actor.workspaceId, registration.id),
        selected: environment.workAreas, requestedAccess: environment.requestedAccess,
        now: new Date().toISOString(),
      });
      bindingId = this.environments.createBinding({
        workspaceId: actor.workspaceId, sessionId: created.session.id, attemptId: created.attempt.id,
        sourceKind: "registration", sourceId: registration.id,
        workAreaKeys: environment.workAreas.map((area) => area.key), accessMode: environment.requestedAccess,
      }).id;
    }
    if (environment.mode === "provision") {
      this.requireInstallation(actor.workspaceId, "execution", environment.executionInstallationId);
      bindingId = this.environments.createBinding({
        workspaceId: actor.workspaceId, sessionId: created.session.id, attemptId: created.attempt.id,
        sourceKind: "allocation", workAreaKeys: environment.workAreas.map((area) => area.key),
        accessMode: environment.workAreas.some((area) => area.requestedAccess === "write") ? "write" : "read",
      }).id;
    }
    if (environment.mode !== "none") {
      const reservationKeys = environment.mode === "existing"
        ? existingReservationKeys({
            environments: this.environments, workspaceId: actor.workspaceId,
            registrationId: environment.registrationId, workAreas: environment.workAreas,
          })
        : environment.workAreas.map((area) => area.key);
      for (const resourceKey of reservationKeys) {
        this.state.addReservation({
          workspaceId: actor.workspaceId, attemptId: created.attempt.id, resourceKey,
          mode: environment.mode === "existing" ? environment.requestedAccess :
            environment.workAreas.some((area) => area.requestedAccess === "write") ? "write" : "read",
          assurance: "hub_only",
        });
      }
    }
    const installationId = environment.mode === "none"
      ? profile.runtimeInstallationId
      : environment.mode === "existing"
        ? this.environments.getRegistration(actor.workspaceId, environment.registrationId).executionInstallationId
        : environment.executionInstallationId;
    const operationId = this.schedule(actor, command.commandId, {
      workType: "delegation.advance",
      connectorKind: environment.mode === "none" ? "runtime" : "execution",
      installationId, stage: "prepare_environment", targetId: created.attempt.id,
      payload: {
        taskId, sessionId: created.session.id, attemptId: created.attempt.id,
        profileId: profile.id, profileRevision: profile.revision, environment,
        ...(bindingId === undefined ? {} : { bindingId }), inputSnapshot: created.attempt.inputSnapshot,
      },
    });
    return this.accepted("attempt.created", "attempt", created.attempt.id, operationId);
  }

  attach(actor: Actor, command: CommandOf<"session.attach">): CommandResult {
    requireProfile(actor, command.payload.profileId);
    return this.sessionAttachment.attach(actor, command);
  }

  takeControl(actor: Actor, command: CommandOf<"session.takeControl">): CommandResult {
    const session = this.execution.getSession(actor.workspaceId, commandTargetId(command, 'session'));
    this.requireInstallation(actor.workspaceId, 'agent_runtime', session.runtimeInstallationId);
    return this.sessionCommands.takeControl(actor, command);
  }

  instruct(actor: Actor, command: CommandOf<"session.instruct">): CommandResult {
    const session = this.execution.getSession(actor.workspaceId, commandTargetId(command, 'session'));
    this.requireInstallation(actor.workspaceId, 'agent_runtime', session.runtimeInstallationId);
    return this.sessionCommands.instruct(actor, command);
  }

  stop(actor: Actor, command: CommandOf<"attempt.stop">): CommandResult {
    return this.sessionCommands.stop(actor, command);
  }

  close(actor: Actor, command: CommandOf<"session.close">): CommandResult {
    return this.sessionCommands.close(actor, command);
  }

  detach(actor: Actor, command: CommandOf<"environment.detach">): CommandResult {
    return this.environmentLifecycle.detach(actor, command);
  }

  release(actor: Actor, command: CommandOf<"environment.release">): CommandResult {
    return this.environmentLifecycle.release(actor, command);
  }

  reconcile(actor: Actor, command: CommandOf<"operation.reconcile">): CommandResult {
    return this.environmentLifecycle.reconcile(actor, command);
  }

  private schedule(actor: Actor, commandId: string, input: {
    readonly workType: string; readonly connectorKind: "execution" | "runtime";
    readonly installationId: string; readonly stage: string; readonly targetId?: string;
    readonly targetGeneration?: number; readonly payload: object;
  }): string {
    return this.operations.addOutbox({ workspaceId: actor.workspaceId, commandId,
      inputDigest: digest(input.payload), ...input });
  }

  private accepted(effect: string, kind: string, id: string, operationId: string): CommandResult {
    return { status: "accepted", confirmedEffect: effect, objectRefs: [{ kind, id }], operationIds: [operationId] };
  }


  private requireInstallation(
    workspaceId: string,
    kind: "execution" | "agent_runtime",
    id: string,
  ): void {
    if (!this.installationUsable(workspaceId, kind, id)) {
      throw unsupported("connector_disabled", `Connector installation ${id} is disabled or unavailable.`);
    }
  }
}
