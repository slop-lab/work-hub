import type { Actor } from "../domain/authorization.ts";
import { requireProject } from "../domain/authorization.ts";
import { commandTargetId } from "../domain/commands.ts";
import { conflict, forbidden } from "../domain/errors.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { ResultRepository } from "../persistence/result-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import type { LifecycleRepository } from "../persistence/lifecycle-repository.ts";
import { authorizeTask, requireRevision, requireRuntimeTargetScope } from "./guards.ts";
import type { CommandOf, CommandResult } from "./types.ts";
import { ResultSubmissionHandler } from "./result-submission-handler.ts";

export type RevisionDispatch =
  | {
      readonly path: "instruction";
      readonly entryId: string;
      readonly sessionId: string;
      readonly attemptId: string;
      readonly instruction: string;
      readonly referenceIds: readonly string[];
      readonly mode: "immediate" | "runtime_queued";
    }
  | {
      readonly path: "continuation";
      readonly entryId: string;
      readonly sessionId: string;
      readonly resultId: string;
      readonly profileId: string;
      readonly instruction: string;
      readonly context: "snapshot" | "current_task";
      readonly environmentReuse: "reuse" | "reattach";
    };

export class WorkHandler {
  private readonly work: WorkRepository;
  private readonly execution: ExecutionRepository;
  private readonly results: ResultRepository;
  private readonly state: StateRepository;
  private readonly lifecycle: LifecycleRepository;
  private readonly submissions: ResultSubmissionHandler;

  constructor(input: {
    readonly work: WorkRepository;
    readonly execution: ExecutionRepository;
    readonly results: ResultRepository;
    readonly state: StateRepository;
    readonly lifecycle: LifecycleRepository;
  }) {
    this.work = input.work;
    this.execution = input.execution;
    this.results = input.results;
    this.state = input.state;
    this.lifecycle = input.lifecycle;
    this.submissions = new ResultSubmissionHandler(input);
  }

  create(actor: Actor, command: CommandOf<"task.create">): CommandResult {
    requireProject(actor, command.payload.projectId);
    const task = this.work.createTask({
      workspaceId: actor.workspaceId, projectId: command.payload.projectId, title: command.payload.title,
      ...(command.payload.description === undefined ? {} : { description: command.payload.description }),
      ...(command.payload.expectedOutcome === undefined ? {} : { expectedOutcome: command.payload.expectedOutcome }),
      ...(command.payload.priority === undefined ? {} : { priority: command.payload.priority }),
      ...(command.payload.ownerId === undefined ? {} : { ownerId: command.payload.ownerId }),
    });
    return this.confirmed("task.persisted", "task", task.id, task.revision);
  }

  update(actor: Actor, command: CommandOf<"task.update">): CommandResult {
    const id = commandTargetId(command, "task");
    const task = this.work.getTask(actor.workspaceId, id);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    const updated = this.work.updateTask(actor.workspaceId, id, {
      ...(command.payload.title === undefined ? {} : { title: command.payload.title }),
      ...(command.payload.description === undefined ? {} : { description: command.payload.description }),
      ...(command.payload.expectedOutcome === undefined ? {} : { expectedOutcome: command.payload.expectedOutcome }),
      ...(command.payload.priority === undefined ? {} : { priority: command.payload.priority }),
      ...(command.payload.ownerId === undefined ? {} : { ownerId: command.payload.ownerId }),
    });
    return this.confirmed("task.updated", "task", id, updated.revision);
  }

  comment(actor: Actor, command: CommandOf<"task.comment">): CommandResult {
    const id = commandTargetId(command, "task");
    const task = this.work.getTask(actor.workspaceId, id);
    authorizeTask(actor, task);
    const entryId = this.work.addEntry(actor.workspaceId, id, actor.id, "comment", command.payload);
    return this.confirmed("task.comment.persisted", "task_entry", entryId);
  }

  setStatus(actor: Actor, command: CommandOf<"task.setStatus">): CommandResult {
    let stopOperationId: string | undefined;
    const id = commandTargetId(command, "task");
    const task = this.work.getTask(actor.workspaceId, id);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    if (command.payload.resultId !== undefined) {
      const result = this.results.get(actor.workspaceId, command.payload.resultId);
      if (result.taskId !== id) throw conflict('completion_result_conflict', 'Select a result belonging to this task.');
      if (command.payload.status === "done") {
        const latest = this.results.latestForTask(actor.workspaceId, id);
        if (latest?.id !== result.id || task.primaryAttemptId !== result.attemptId) {
          throw conflict("result_obsolete", "Only the current primary attempt result can complete the task.");
        }
        if (result.kind !== "final") throw conflict("result_not_final", "Checkpoint results cannot complete the task.");
        const evidence = new Map(result.criterionEvidence.map((item) => [item.criterionId, item.status]));
        const criteria = this.lifecycle.currentCriteria(actor.workspaceId, id);
        if (criteria.some((criterion) =>
          criterion.requirement === "required" && evidence.get(criterion.id) !== "satisfied")) {
          throw conflict("acceptance_criteria_missing", "Required criteria lack satisfactory evidence.");
        }
        if (criteria.length > 0) {
          const acceptance = this.lifecycle.view(actor.workspaceId, id).acceptance;
          if (acceptance?.decision !== "accepted" || acceptance.resultId !== result.id) throw conflict(
            "acceptance_required", "Tasks with explicit criteria require an accepted current result decision.");
        }
      }
    } else if (command.payload.status === "done" &&
      this.lifecycle.currentCriteria(actor.workspaceId, id).length > 0) {
      throw conflict("acceptance_required", "Tasks with explicit criteria require an accepted current result decision.");
    }
    if (task.primaryAttemptId !== undefined) {
      const attempt = this.execution.getAttempt(actor.workspaceId, task.primaryAttemptId);
      if (attempt.unresolved && command.payload.activeExecutionDecision === undefined) {
        throw conflict(
          "active_execution_requires_decision",
          "Completing or canceling a task with active work requires an explicit decision.",
        );
      }
      if (attempt.unresolved && command.payload.activeExecutionDecision === "request_stop") {
        stopOperationId = this.state.requestStopAndSchedule({
          workspaceId: actor.workspaceId, attemptId: attempt.id, commandId: command.commandId,
        });
      }
    }
    const updated = this.work.setStatus(actor.workspaceId, id, command.payload.status);
    const entryId = this.work.addEntry(actor.workspaceId, id, actor.id, 'human_decision', { status: command.payload.status, resultId: command.payload.resultId, completionNote: command.payload.completionNote, activeExecutionDecision: command.payload.activeExecutionDecision, taskRevision: updated.revision, text: `${command.payload.status === 'done' ? 'Completion note' : `Task decision (${command.payload.status})`}: ${command.payload.completionNote ?? 'Explicit business-state decision.'}` });
    return {
      status: "confirmed", confirmedEffect: "task.status_changed",
      objectRefs: [{ kind: "task", id, revision: updated.revision }, { kind: 'task_entry', id: entryId }],
      operationIds: stopOperationId === undefined ? [] : [stopOperationId],
    };
  }

  archive(actor: Actor, command: CommandOf<"task.archive">): CommandResult {
    const id = commandTargetId(command, "task");
    const task = this.work.getTask(actor.workspaceId, id);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    if (task.primaryAttemptId !== undefined) {
      const attempt = this.execution.getAttempt(actor.workspaceId, task.primaryAttemptId);
      if (attempt.unresolved) {
        throw conflict("unsafe_archive", "A task with unresolved primary work cannot be archived.");
      }
    }
    if (this.state.hasUnresolvedApprovalDelivery(actor.workspaceId, id)) {
      throw conflict("unsafe_archive", "A task with unresolved approval delivery cannot be archived.");
    }
    if (this.state.hasUnresolvedManagedRelease(actor.workspaceId, id)) {
      throw conflict("unsafe_archive", "A task with unresolved managed allocation release cannot be archived.");
    }
    const archived = this.work.archive(actor.workspaceId, id);
    return this.confirmed("task.archived", "task", id, archived.revision);
  }

  submitResult(actor: Actor, command: CommandOf<"result.submit">): CommandResult {
    return this.submissions.submit(actor, command);
  }

  reportActivity(actor: Actor, command: CommandOf<'attempt.report'>): CommandResult {
    if (actor.role !== 'runtime') throw forbidden('Activity reports require a scoped runtime principal.');
    const attemptId = commandTargetId(command, 'attempt');
    const attempt = this.execution.getAttempt(actor.workspaceId, attemptId);
    const session = this.execution.getSession(actor.workspaceId, attempt.sessionId);
    requireProject(actor, session.projectId);
    requireRuntimeTargetScope(actor, session, attempt.id);
    const entryId = this.work.addEntry(actor.workspaceId, attempt.taskId, actor.id, 'runtime_report', { ...command.payload, attemptId, sessionId: session.id, bindingGeneration: session.bindingGeneration, source: 'scoped_bridge', assurance: 'reported', text: `Runtime reported ${command.payload.phase}. Native termination is not established by this report.${command.payload.note ? ` ${command.payload.note}` : ''}` });
    return this.confirmed('attempt.activity_report.persisted', 'task_entry', entryId);
  }

  requestRevision(actor: Actor, command: CommandOf<"task.requestRevision">): RevisionDispatch {
    const taskId = commandTargetId(command, "task");
    const task = this.work.getTask(actor.workspaceId, taskId);
    authorizeTask(actor, task);
    requireRevision(task.revision, command.expected?.task, "Task");
    const result = this.results.get(actor.workspaceId, command.payload.resultId);
    const attempt = this.execution.getAttempt(actor.workspaceId, result.attemptId);
    const session = this.execution.getSession(actor.workspaceId, command.payload.sessionId);
    if (result.taskId !== task.id || attempt.taskId !== task.id || attempt.sessionId !== session.id ||
      session.taskId !== task.id) {
      throw conflict("revision_target_conflict", "The selected result, attempt, session, and task do not match.");
    }
    if (session.activeAttemptId !== attempt.id || task.primaryAttemptId !== attempt.id) {
      throw conflict("revision_target_obsolete", "The selected result is not from the current task attempt.");
    }
    if (command.payload.path === "instruction" &&
      (!attempt.unresolved || !["running", "waiting_input"].includes(attempt.phase))) {
      throw conflict("revision_path_invalid", "The selected result attempt is no longer active; choose continuation.");
    }
    if (command.payload.path === "continuation" && (attempt.unresolved || attempt.phase !== "finished")) {
      throw conflict("revision_path_invalid", "Continuation requires proven termination of the selected result attempt.");
    }
    const entryId = this.work.addEntry(actor.workspaceId, taskId, actor.id, "revision_request", {
      ...command.payload, attemptId: attempt.id,
    });
    if (command.payload.path === "instruction") {
      return {
        path: "instruction", entryId, sessionId: session.id, attemptId: attempt.id,
        instruction: command.payload.instruction, referenceIds: result.referenceIds,
        mode: command.payload.mode,
      };
    }
    return {
      path: "continuation", entryId, sessionId: session.id, resultId: result.id,
      profileId: command.payload.profileId, instruction: command.payload.instruction,
      context: command.payload.context, environmentReuse: command.payload.environmentReuse,
    };
  }

  private confirmed(effect: string, kind: string, id: string, revision?: number): CommandResult {
    return {
      status: "confirmed", confirmedEffect: effect,
      objectRefs: [{ kind, id, ...(revision === undefined ? {} : { revision }) }],
      operationIds: [],
    };
  }
}
