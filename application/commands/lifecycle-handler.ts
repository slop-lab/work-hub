import type { Actor } from "../domain/authorization.ts";
import { commandTargetId } from "../domain/commands.ts";
import { conflict } from "../domain/errors.ts";
import { criterionEvidenceSatisfies } from "../domain/lifecycle-evidence.ts";
import type { LifecycleRepository } from "../persistence/lifecycle-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { ResultRepository } from "../persistence/result-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import { authorizeTask, requireRevision } from "./guards.ts";
import type { CommandOf, CommandResult } from "./types.ts";

export type ControlledRecoveryDispatch =
  | { readonly kind: "resume"; readonly command: CommandOf<"session.continue">;
      readonly reason: string; readonly retryOrdinal: number; readonly retryLimit: number }
  | { readonly kind: "retry"; readonly command: CommandOf<"attempt.retry"> }
  | { readonly kind: "escalated"; readonly result: CommandResult };

export class LifecycleHandler {
  private readonly dependencies: {
    readonly lifecycle: LifecycleRepository;
    readonly work: WorkRepository;
    readonly execution: ExecutionRepository;
    readonly results: ResultRepository;
    readonly state: StateRepository;
  };

  constructor(dependencies: {
    readonly lifecycle: LifecycleRepository;
    readonly work: WorkRepository;
    readonly execution: ExecutionRepository;
    readonly results: ResultRepository;
    readonly state: StateRepository;
  }) {
    this.dependencies = dependencies;
  }

  amend(actor: Actor, command: CommandOf<"task.amend">): CommandResult {
    const taskId = commandTargetId(command, "task");
    const task = this.dependencies.work.getTask(actor.workspaceId, taskId);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    if (task.status === "done" ||
      this.dependencies.lifecycle.view(actor.workspaceId, taskId).acceptance?.decision === "accepted") {
      throw conflict("terminal_scope_accepted",
        "Accepted terminal scope cannot be amended; create explicit follow-up work instead.");
    }
    const amendment = this.dependencies.lifecycle.amend({ workspaceId: actor.workspaceId,
      taskId, authorId: actor.id, summary: command.payload.summary,
      criteria: command.payload.criteria,
      supersedesCriterionIds: command.payload.supersedesCriterionIds });
    const updated = this.dependencies.work.getTask(actor.workspaceId, taskId);
    return { status: "confirmed", confirmedEffect: "task.amendment.persisted",
      objectRefs: [{ kind: "task_amendment", id: amendment.id, revision: amendment.revision },
        { kind: "task", id: taskId, revision: updated.revision }], operationIds: [] };
  }

  acceptResult(actor: Actor, command: CommandOf<"task.acceptResult">): CommandResult {
    const taskId = commandTargetId(command, "task");
    const task = this.dependencies.work.getTask(actor.workspaceId, taskId);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    const result = this.dependencies.results.get(actor.workspaceId, command.payload.resultId);
    if (result.taskId !== taskId) {
      throw conflict("completion_result_conflict", "Select a result belonging to this task.");
    }
    const latest = this.dependencies.results.latestForTask(actor.workspaceId, taskId);
    if (latest?.id !== result.id || task.primaryAttemptId !== result.attemptId) {
      throw conflict("result_obsolete", "Only the current primary attempt result can be decided.");
    }
    const attempt = this.dependencies.execution.getAttempt(actor.workspaceId, result.attemptId);
    const criteria = this.dependencies.lifecycle.currentCriteria(actor.workspaceId, taskId);
    const evidence = new Map(result.criterionEvidence.map((item) => [item.criterionId, item]));
    const computedMissing = criteria.filter((criterion) => criterion.requirement === "required" &&
      !criterionEvidenceSatisfies(criterion, evidence.get(criterion.id))).map((criterion) => criterion.id);
    const suppliedMissing = [...command.payload.missingCriteria].sort();
    if (command.payload.decision === "accepted") {
      if (result.kind !== "final") throw conflict("result_not_final", "Checkpoint results cannot be accepted.");
      if (computedMissing.length > 0 || suppliedMissing.length > 0) {
        throw conflict("acceptance_criteria_missing", "Required criteria lack satisfactory evidence.");
      }
      if (attempt.unresolved && command.payload.activeExecutionDecision === undefined) {
        throw conflict("active_execution_requires_decision",
          "Accepting a result with active work requires an explicit decision.");
      }
    } else if (computedMissing.slice().sort().join("\n") !== suppliedMissing.join("\n")) {
      throw conflict("missing_criteria_mismatch", "The explicit missing criteria must match current result gaps.");
    }
    const status = command.payload.decision === "accepted" ? "done" : "review";
    const acceptance = this.dependencies.lifecycle.accept({ workspaceId: actor.workspaceId, taskId,
      resultId: result.id, actorId: actor.id, decision: command.payload.decision,
      missingCriteria: command.payload.missingCriteria,
      businessIntentEpoch: task.businessIntentEpoch + (task.status === status ? 0 : 1),
      ...(command.payload.note === undefined ? {} : { note: command.payload.note }) });
    const updated = task.status === status ? task : this.dependencies.work.setStatus(actor.workspaceId, taskId, status);
    const stopOperationId = attempt.unresolved && command.payload.decision === "accepted" &&
      command.payload.activeExecutionDecision === "request_stop"
      ? this.dependencies.state.requestStopAndSchedule({ workspaceId: actor.workspaceId,
          attemptId: result.attemptId, commandId: command.commandId })
      : undefined;
    this.dependencies.work.addEntry(actor.workspaceId, taskId, actor.id, "result_acceptance", {
      resultId: result.id, decision: command.payload.decision,
      missingCriteria: command.payload.missingCriteria, note: command.payload.note,
      activeExecutionDecision: command.payload.activeExecutionDecision,
    });
    return { status: "confirmed", confirmedEffect: "result.acceptance.persisted",
      objectRefs: [{ kind: "result_acceptance", id: acceptance.id },
        { kind: "task", id: taskId, revision: updated.revision }],
      operationIds: stopOperationId === undefined ? [] : [stopOperationId] };
  }

  openBlocker(actor: Actor, command: CommandOf<"blocker.open">): CommandResult {
    const taskId = commandTargetId(command, "task");
    const task = this.dependencies.work.getTask(actor.workspaceId, taskId);
    authorizeTask(actor, task);
    if (command.payload.attemptId !== undefined) {
      const attempt = this.dependencies.execution.getAttempt(actor.workspaceId, command.payload.attemptId);
      if (attempt.taskId !== taskId) throw conflict("blocker_attempt_conflict", "Blocker attempt belongs to another task.");
    }
    const blocker = this.dependencies.lifecycle.openBlocker({ workspaceId: actor.workspaceId,
      taskId, ...(command.payload.attemptId === undefined ? {} : { attemptId: command.payload.attemptId }),
      kind: command.payload.kind, owner: command.payload.owner, remedy: command.payload.remedy,
      detail: command.payload.detail });
    return this.confirmed("blocker.opened", "blocker", blocker.id);
  }

  resolveBlocker(actor: Actor, command: CommandOf<"blocker.resolve">): CommandResult {
    const blocker = this.dependencies.lifecycle.transitionBlocker(actor.workspaceId,
      commandTargetId(command, "blocker"), { status: "resolved", resolution: command.payload.resolution });
    this.authorizeBlocker(actor, blocker.taskId);
    return this.confirmed("blocker.resolved", "blocker", blocker.id);
  }

  recheckBlocker(actor: Actor, command: CommandOf<"blocker.recheck">): CommandResult {
    const blocker = this.dependencies.lifecycle.transitionBlocker(actor.workspaceId,
      commandTargetId(command, "blocker"), { status: "rechecking", note: command.payload.note });
    this.authorizeBlocker(actor, blocker.taskId);
    return this.confirmed("blocker.recheck_recorded", "blocker", blocker.id);
  }

  reconcileAttempt(actor: Actor, command: CommandOf<"attempt.reconcile">): CommandResult {
    const attemptId = commandTargetId(command, "attempt");
    const attempt = this.dependencies.execution.getAttempt(actor.workspaceId, attemptId);
    this.authorizeBlocker(actor, attempt.taskId);
    this.dependencies.lifecycle.reconcileAttempt({ workspaceId: actor.workspaceId, attemptId,
      interruption: command.payload.interruption, recovery: command.payload.recovery });
    return this.confirmed("attempt.reconciliation.persisted", "attempt", attemptId);
  }

  controlledResume(actor: Actor, command: CommandOf<"attempt.controlledResume">): ControlledRecoveryDispatch {
    const attemptId = commandTargetId(command, "attempt");
    const attempt = this.dependencies.execution.getAttempt(actor.workspaceId, attemptId);
    this.authorizeBlocker(actor, attempt.taskId);
    const task = this.dependencies.work.getTask(actor.workspaceId, attempt.taskId);
    if (task.primaryAttemptId !== attempt.id) {
      throw conflict("recovery_target_obsolete", "Controlled recovery requires the task's current attempt.");
    }
    if (attempt.interruption === undefined) {
      throw conflict("attempt_not_interrupted", "Controlled recovery requires a recorded interruption.");
    }
    if (attempt.retryOrdinal > 0 && command.payload.retryLimit !== attempt.retryLimit) {
      throw conflict("retry_budget_fixed", "The retained retry budget cannot be changed after retry work starts.");
    }
    if (command.payload.recovery === "resume") {
      const session = this.dependencies.execution.getSession(actor.workspaceId, attempt.sessionId);
      return { kind: "resume", reason: command.payload.reason,
        retryOrdinal: attempt.retryOrdinal, retryLimit: attempt.retryLimit, command: {
        commandId: command.commandId,
        type: "session.continue",
        target: { kind: "session", id: session.id },
        expected: { session: session.revision, task: task.revision, profile: attempt.profileRevision },
        payload: { profileId: attempt.profileId, context: "current_task", environmentReuse: "reuse",
          instruction: command.payload.reason },
      } };
    }
    if (command.payload.recovery === "retry") {
      return { kind: "retry", command: {
        commandId: command.commandId,
        type: "attempt.retry",
        target: { kind: "attempt", id: attempt.id },
        expected: { task: task.revision, profile: attempt.profileRevision },
        payload: { predecessorId: attempt.id, input: "snapshot", reason: command.payload.reason,
          retryLimit: command.payload.retryLimit, sameSession: false },
      } };
    }
    this.dependencies.lifecycle.controlledResume({ workspaceId: actor.workspaceId, attemptId,
      recovery: command.payload.recovery, reason: command.payload.reason,
      retryLimit: command.payload.retryLimit });
    return { kind: "escalated", result: this.confirmed("attempt.recovery.persisted", "attempt", attemptId) };
  }

  private authorizeBlocker(actor: Actor, taskId: string): void {
    authorizeTask(actor, this.dependencies.work.getTask(actor.workspaceId, taskId));
  }

  recordResume(input: { readonly workspaceId: string; readonly attemptId: string;
    readonly reason: string; readonly retryOrdinal: number; readonly retryLimit: number }): void {
    this.dependencies.lifecycle.recordResume(input);
  }

  private confirmed(effect: string, kind: string, id: string): CommandResult {
    return { status: "confirmed", confirmedEffect: effect,
      objectRefs: [{ kind, id }], operationIds: [] };
  }
}
