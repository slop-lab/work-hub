import type { Actor } from "../domain/authorization.ts";
import { commandTargetId } from "../domain/commands.ts";
import { conflict, unsupported } from "../domain/errors.ts";
import type { AttemptFactory } from "../persistence/attempt-factory.ts";
import { digest } from "../persistence/codec.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository } from "../persistence/operation-repository.ts";
import type { ObservationRepository } from "../persistence/observation-repository.ts";
import type { ResultRepository } from "../persistence/result-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import type { HandoffRepository } from "../persistence/handoff-repository.ts";
import type { LifecycleRepository } from "../persistence/lifecycle-repository.ts";
import { authorizeSessionControl, authorizeTask, requireRevision } from "./guards.ts";
import type { CommandOf, CommandResult } from "./types.ts";
import { ContinuationPolicy } from "./continuation-policy.ts";
import { prepareRetryEnvironment } from "./retry-environment.ts";

type ContinuationDependencies = {
  readonly work: WorkRepository;
  readonly execution: ExecutionRepository;
  readonly attempts: AttemptFactory;
  readonly operations: OperationRepository;
  readonly environments: EnvironmentRepository;
  readonly results: ResultRepository;
  readonly observation: ObservationRepository;
  readonly state: StateRepository;
  readonly handoffs: HandoffRepository;
  readonly lifecycle: LifecycleRepository;
  readonly installationUsable: (
    workspaceId: string, kind: "execution" | "agent_runtime", installationId: string,
  ) => boolean;
  readonly runtimeSupports: (installationId: string, names: readonly string[]) => boolean;
  readonly now: () => Date;
};

export class ContinuationHandler {
  private readonly dependencies: ContinuationDependencies;
  private readonly policy: ContinuationPolicy;

  constructor(dependencies: ContinuationDependencies) {
    this.dependencies = dependencies;
    this.policy = new ContinuationPolicy(dependencies);
  }

  continue(actor: Actor, command: CommandOf<"session.continue">): CommandResult {
    const sessionId = commandTargetId(command, "session");
    const session = this.dependencies.execution.getSession(actor.workspaceId, sessionId);
    authorizeSessionControl(actor, session);
    requireRevision(session.revision, command.expected?.session, "Session");
    if (session.lifecycle !== "open" || session.activeAttemptId === undefined) {
      throw conflict("session_not_continuable", "The session has no previous attempt to continue.");
    }
    const predecessor = this.dependencies.execution.getAttempt(actor.workspaceId, session.activeAttemptId);
    if (predecessor.unresolved) {
      throw conflict("predecessor_unresolved", "The previous attempt may still be running.");
    }
    this.policy.requireContinuationCapability(session.capabilities);
    const task = this.dependencies.work.getTask(actor.workspaceId, session.taskId);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    if (task.archivedAt !== undefined || task.status === "done" || task.status === "canceled") {
      throw conflict("task_not_delegable", "Reopen an unarchived task before continuing work.");
    }
    const profile = this.policy.profileForStart(actor, command.payload.profileId, command.expected?.profile);
    if (profile.runtimeInstallationId !== session.runtimeInstallationId) {
      throw conflict("continuation_installation_conflict", "Continuation must use the native session's runtime installation.");
    }
    const workAreas = this.policy.runtimeAndEnvironment(actor.workspaceId, session.id, profile, command.payload.environmentReuse);
    const sourceResult = command.payload.sourceResultId === undefined
      ? undefined
      : this.dependencies.results.get(actor.workspaceId, command.payload.sourceResultId);
    if (sourceResult !== undefined &&
      (sourceResult.taskId !== task.id || sourceResult.attemptId !== predecessor.id)) {
      throw conflict("revision_target_conflict", "The continuation result does not belong to its predecessor attempt.");
    }
    const attemptId = this.dependencies.attempts.createContinuation({
      workspaceId: actor.workspaceId,
      task,
      session,
      profile,
      instruction: command.payload.instruction,
      predecessor,
      context: command.payload.context,
      ...(sourceResult === undefined ? {} : { sourceResult }),
    });
    const continued = this.dependencies.execution.getAttempt(actor.workspaceId, attemptId);
    this.dependencies.handoffs.preserveLineage({ workspaceId: actor.workspaceId,
      sourceAttempt: predecessor, attempt: continued, task });
    const operationId = this.schedule(actor, command.commandId, session.runtimeInstallationId, {
      sessionId,
      attemptId,
      input: this.dependencies.execution.getAttempt(actor.workspaceId, attemptId).inputSnapshot,
      workAreas,
    }, session.bindingGeneration);
    return this.accepted(attemptId, operationId);
  }

  retry(actor: Actor, command: CommandOf<"attempt.retry">): CommandResult {
    const predecessorId = commandTargetId(command, "attempt");
    if (command.payload.predecessorId !== predecessorId) {
      throw conflict("retry_target_conflict", "The retry predecessor must match the command target.");
    }
    if (command.payload.recoveryDecisionId !== undefined) {
      throw unsupported("recovery_decision_unsupported", "No durable exceptional recovery decision contract is configured.");
    }
    const predecessor = this.dependencies.execution.getAttempt(actor.workspaceId, predecessorId);
    if (predecessor.unresolved) {
      throw conflict("predecessor_unresolved", "Retry requires proven termination of the predecessor attempt.");
    }
    const task = this.dependencies.work.getTask(actor.workspaceId, predecessor.taskId);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    if (task.archivedAt !== undefined || task.status === "done" || task.status === "canceled") {
      throw conflict("task_not_delegable", "Reopen an unarchived task before retrying work.");
    }
    const profile = this.policy.profileForStart(
      actor, command.payload.profileId ?? predecessor.profileId, command.expected?.profile,
    );
    const priorInstruction = predecessor.inputSnapshot["instruction"];
    const instruction = command.payload.input === "snapshot" && typeof priorInstruction === "string"
      ? priorInstruction
      : `${task.title}\n\n${task.description}`.trim();
    if (command.payload.sameSession) {
      const session = this.dependencies.execution.getSession(actor.workspaceId, predecessor.sessionId);
      if (session.activeAttemptId !== predecessor.id) {
        throw conflict("retry_target_obsolete", "The retry predecessor is no longer the session's current attempt.");
      }
      const continued = this.continue(actor, {
        commandId: command.commandId,
        type: "session.continue",
        target: { kind: "session", id: session.id },
        expected: { session: session.revision, task: task.revision, profile: profile.revision },
        payload: {
          profileId: profile.id,
          context: command.payload.input,
          environmentReuse: "reuse",
          instruction,
        },
      });
      const attemptId = continued.objectRefs[0]?.id;
      if (attemptId === undefined) throw new TypeError("Continuation did not return its attempt identity.");
      this.dependencies.lifecycle.recordRetry({ workspaceId: actor.workspaceId, attemptId,
        predecessorOrdinal: predecessor.retryOrdinal, limit: command.payload.retryLimit,
        reason: command.payload.reason });
      return continued;
    }
    const selectedEnvironment = command.payload.environment ?? profile.defaultEnvironment;
    const selectedMode = Reflect.get(selectedEnvironment, "mode");
    if (selectedMode === "provision") {
      const installationId = Reflect.get(selectedEnvironment, "executionInstallationId");
      if (typeof installationId !== "string" || !this.dependencies.installationUsable(
        actor.workspaceId, "execution", installationId,
      )) {
        throw unsupported("connector_disabled",
          "The selected execution installation is disabled or unavailable.");
      }
    }
    if (selectedMode === "existing") {
      const registrationId = Reflect.get(selectedEnvironment, "registrationId");
      if (typeof registrationId !== "string") {
        throw conflict("registration_not_found", "The selected environment registration is unavailable.");
      }
      const executionInstallationId = this.dependencies.environments.getRegistration(
        actor.workspaceId, registrationId,
      ).executionInstallationId;
      if (!this.dependencies.installationUsable(
        actor.workspaceId, "execution", executionInstallationId,
      )) {
        throw unsupported("connector_disabled",
          "The selected execution installation is disabled or unavailable.");
      }
    }
    const created = this.dependencies.attempts.createRetryHandoff({
      workspaceId: actor.workspaceId,
      task,
      profile,
      predecessor,
      context: command.payload.input,
    });
    this.dependencies.handoffs.preserveLineage({ workspaceId: actor.workspaceId,
      sourceAttempt: predecessor, attempt: created.attempt, task });
    this.dependencies.lifecycle.recordRetry({ workspaceId: actor.workspaceId,
      attemptId: created.attempt.id, predecessorOrdinal: predecessor.retryOrdinal,
      limit: command.payload.retryLimit, reason: command.payload.reason });
    const retryEnvironment = prepareRetryEnvironment({ actor, task, profile,
      ...(command.payload.environment === undefined ? {} : { requested: command.payload.environment }),
      ...(command.expected?.registration === undefined ? {} : {
        expectedRegistrationRevision: command.expected.registration,
      }),
      sessionId: created.session.id, attemptId: created.attempt.id,
      environments: this.dependencies.environments, state: this.dependencies.state,
      now: this.dependencies.now() });
    const operationId = this.dependencies.operations.addOutbox({
      workspaceId: actor.workspaceId,
      commandId: command.commandId,
      workType: "delegation.advance",
      connectorKind: retryEnvironment.connectorKind,
      installationId: retryEnvironment.installationId,
      stage: "open_new_session",
      targetId: created.attempt.id,
      payload: {
        taskId: task.id,
        sessionId: created.session.id,
        attemptId: created.attempt.id,
        profileId: profile.id,
        profileRevision: profile.revision,
        environment: retryEnvironment.environment,
        ...(retryEnvironment.bindingId === undefined ? {} : { bindingId: retryEnvironment.bindingId }),
        inputSnapshot: created.attempt.inputSnapshot,
      },
      inputDigest: digest(created.attempt.inputSnapshot),
    });
    return this.accepted(created.attempt.id, operationId);
  }

  private schedule(
    actor: Actor,
    commandId: string,
    installationId: string,
    payload: object,
    generation: number,
  ): string {
    return this.dependencies.operations.addOutbox({
      workspaceId: actor.workspaceId,
      commandId,
      workType: "runtime.startAttempt",
      connectorKind: "runtime",
      installationId,
      stage: "start_continuation",
      targetGeneration: generation,
      payload,
      inputDigest: digest(payload),
    });
  }

  private accepted(attemptId: string, operationId: string): CommandResult {
    return {
      status: "accepted",
      confirmedEffect: "attempt.created",
      objectRefs: [{ kind: "attempt", id: attemptId }],
      operationIds: [operationId],
    };
  }
}
