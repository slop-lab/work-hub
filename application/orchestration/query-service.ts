import type { Actor } from "../domain/authorization.ts";
import { requireProject } from "../domain/authorization.ts";
import { forbidden } from "../domain/errors.ts";
import type {
  DashboardView,
  EnvironmentBindingView,
  EnvironmentRegistrationView,
  HubCommandReceipt,
  HubSnapshot,
  RequestView,
  SessionView,
  TaskStatus,
  TaskView,
} from "../domain/model.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { InteractionRepository } from "../persistence/interaction-repository.ts";
import type { OperationRepository } from "../persistence/operation-repository.ts";
import type { QueryRepository } from "../persistence/query-repository.ts";
import type { ResultRepository } from "../persistence/result-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import { paginate } from './pagination.ts';

export type TaskListQuery = {
  readonly projectId?: string;
  readonly status?: TaskStatus;
  readonly ownerId?: string;
  readonly priority?: number;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly includeArchived?: boolean;
};

export type Page<T> = {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly snapshotCursor: string;
};

export class QueryService {
  private readonly work: WorkRepository;
  private readonly interactions: InteractionRepository;
  private readonly execution: ExecutionRepository;
  private readonly environments: EnvironmentRepository;
  private readonly results: ResultRepository;
  private readonly operations: OperationRepository;
  private readonly query: QueryRepository;

  constructor(input: {
    readonly work: WorkRepository; readonly interactions: InteractionRepository;
    readonly execution: ExecutionRepository; readonly environments: EnvironmentRepository;
    readonly results: ResultRepository; readonly operations: OperationRepository;
    readonly query: QueryRepository;
  }) {
    this.work = input.work;
    this.interactions = input.interactions;
    this.execution = input.execution;
    this.environments = input.environments;
    this.results = input.results;
    this.operations = input.operations;
    this.query = input.query;
  }

  getTask(actor: Actor, id: string): TaskView {
    const task = this.work.getTask(actor.workspaceId, id);
    requireProject(actor, task.projectId);
    if (actor.role === 'runtime') {
      const session = actor.sessionId ? this.execution.getSession(actor.workspaceId, actor.sessionId) : undefined;
      if (!session || session.taskId !== id || session.bindingGeneration !== actor.bindingGeneration) throw forbidden('The task is outside the runtime credential scope.');
    }
    return task;
  }

  listTasks(actor: Actor, input: TaskListQuery = {}): Page<TaskView> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
    const runtimeSession = actor.role === 'runtime' ? this.execution.listSessions(actor.workspaceId).find((session) => session.id === actor.sessionId && session.bindingGeneration === actor.bindingGeneration) : undefined;
    const search = input.search?.toLocaleLowerCase();
    const filtered = this.work.listTasks(actor.workspaceId).filter((task) =>
      (actor.role === "administrator" || actor.projectIds.includes(task.projectId)) &&
      (actor.role !== 'runtime' || task.id === runtimeSession?.taskId) &&
      (input.includeArchived === true || task.archivedAt === undefined) &&
      (input.projectId === undefined || task.projectId === input.projectId) &&
      (input.status === undefined || task.status === input.status) &&
      (input.ownerId === undefined || task.ownerId === input.ownerId) &&
      (input.priority === undefined || task.priority === input.priority) &&
      (search === undefined || `${task.title}\n${task.description}\n${task.expectedOutcome ?? ''}`.toLocaleLowerCase().includes(search)),
    );
    const { cursor, ...query } = input;
    const page = paginate({ items: filtered, key: (task) => `${String(task.priority ?? 50).padStart(3, '0')}:${9999999999999 - Date.parse(task.updatedAt)}:${task.id}`, query: JSON.stringify({ actorId: actor.id, workspaceId: actor.workspaceId, ...query }), snapshot: this.query.watermark(actor.workspaceId), limit, ...(cursor ? { cursor } : {}) });
    return {
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      snapshotCursor: page.snapshotCursor,
    };
  }

  getRequest(actor: Actor, id: string): RequestView {
    const request = this.interactions.getRequest(actor.workspaceId, id);
    requireProject(actor, request.projectId);
    if (actor.role === 'runtime' && (request.sessionId !== actor.sessionId || request.attemptId !== actor.attemptId || request.bindingGeneration !== actor.bindingGeneration)) throw forbidden('The request is outside the runtime credential scope.');
    return request;
  }

  getSession(actor: Actor, id: string): {
    readonly session: SessionView;
    readonly attempt?: ReturnType<ExecutionRepository["getAttempt"]>;
    readonly requests: readonly RequestView[];
    readonly results: ReturnType<ResultRepository["list"]>;
    readonly output: readonly Readonly<Record<string, unknown>>[];
    readonly availableCommandTypes: readonly string[];
  } {
    const session = this.execution.getSession(actor.workspaceId, id);
    requireProject(actor, session.projectId);
    if (actor.role === 'runtime' && (session.id !== actor.sessionId || session.bindingGeneration !== actor.bindingGeneration)) throw forbidden('The session is outside the runtime credential scope.');
    const attempt = session.activeAttemptId === undefined
      ? undefined : this.execution.getAttempt(actor.workspaceId, session.activeAttemptId);
    return {
      session,
      ...(attempt === undefined ? {} : { attempt }),
      requests: this.interactions.listRequests(actor.workspaceId).filter((request) => request.sessionId === id),
      results: this.results.list(actor.workspaceId).filter((result) => result.attemptId === attempt?.id),
      output: this.query.outputPage(actor.workspaceId, { sessionId: id, after: -2147483648, limit: 100 }).items,
      availableCommandTypes: session.controlMode === "control"
        ? ["session.instruct", "attempt.stop", "session.continue", "session.close"]
        : ["session.takeControl", "session.close"],
    };
  }

  getEnvironmentRegistration(actor: Actor, id: string): EnvironmentRegistrationView {
    const registration = this.environments.getRegistration(actor.workspaceId, id);
    if (actor.role !== "administrator" && !registration.allowedProjectIds.some((projectId) => actor.projectIds.includes(projectId))) {
      throw forbidden("The actor cannot inspect this environment registration.");
    }
    return registration;
  }

  getEnvironmentBinding(actor: Actor, id: string): EnvironmentBindingView {
    const binding = this.environments.getBinding(actor.workspaceId, id);
    if (actor.role !== "administrator" && !actor.bindingIds.includes(id)) {
      const session = this.execution.getSession(actor.workspaceId, binding.sessionId);
      requireProject(actor, session.projectId);
    }
    return binding;
  }

  getCommandReceipt(actor: Actor, commandId: string): HubCommandReceipt | undefined {
    return this.operations.findReceipt(actor.workspaceId, actor.id, commandId)?.receipt;
  }

  getOutput(actor: Actor, sessionId: string, query: { readonly after: number; readonly limit: number }) {
    const session = this.getSession(actor, sessionId).session;
    const page = this.query.outputPage(actor.workspaceId, { sessionId, after: query.after, limit: Math.max(1, Math.min(query.limit, 100)) });
    return { ...page, session, items: page.items.filter((item) => actor.role !== 'runtime' || item['attemptId'] === actor.attemptId) };
  }

  dashboard(actor: Actor): DashboardView {
    return this.snapshot(actor).dashboard;
  }

  snapshot(actor: Actor): HubSnapshot {
    const allSessions = this.execution.listSessions(actor.workspaceId);
    const scopedSession = actor.role === 'runtime' ? allSessions.find((session) => session.id === actor.sessionId && session.bindingGeneration === actor.bindingGeneration) : undefined;
    const tasks = this.work.listTasks(actor.workspaceId).filter((task) =>
      (actor.role === "administrator" || actor.projectIds.includes(task.projectId)) && (actor.role !== 'runtime' || task.id === scopedSession?.taskId));
    const taskIds = new Set(tasks.map((task) => task.id));
    const requests = this.interactions.listRequests(actor.workspaceId).filter((request) =>
      (actor.role === "administrator" || actor.projectIds.includes(request.projectId)) && (actor.role !== 'runtime' || (request.sessionId === actor.sessionId && request.attemptId === actor.attemptId && request.bindingGeneration === actor.bindingGeneration)));
    const requestIds = new Set(requests.map((request) => request.id));
    const sessions = allSessions.filter((session) =>
      (actor.role === "administrator" || actor.projectIds.includes(session.projectId)) && (actor.role !== 'runtime' || session.id === scopedSession?.id));
    const sessionIds = new Set(sessions.map((session) => session.id));
    const attempts = this.execution.listAttempts(actor.workspaceId).filter((attempt) => taskIds.has(attempt.taskId) && (actor.role !== 'runtime' || attempt.id === actor.attemptId));
    const attemptIds = new Set(attempts.map((attempt) => attempt.id));
    const deliveries = this.query.deliveries(actor.workspaceId).filter((delivery) => typeof delivery['requestId'] === 'string' && requestIds.has(delivery['requestId']));
    const results = this.results.list(actor.workspaceId).filter((result) => attemptIds.has(result.attemptId));
    const bindings = this.environments.listBindings(actor.workspaceId).filter((binding) => sessionIds.has(binding.sessionId));
    const targetIds = new Set([...taskIds, ...sessionIds, ...attemptIds, ...bindings.map((binding) => binding.id)]);
    const operations = this.query.operations(actor.workspaceId).filter((operation) => actor.role === 'administrator' || (typeof operation['targetId'] === 'string' && targetIds.has(operation['targetId'])));
    const openRequests = requests.filter((request) => request.status === 'open' && this.canActOnRequest(actor, request));
    return {
      projects: this.query.projects(actor.workspaceId).filter((project) =>
        actor.role === "administrator" ||
        (typeof project["id"] === "string" && actor.projectIds.includes(project["id"]))),
      users: actor.role === "administrator" ? this.query.users(actor.workspaceId) : [],
      tasks,
      entries: this.query.entries(actor.workspaceId).filter((entry) =>
        typeof entry["taskId"] === "string" && taskIds.has(entry["taskId"])),
      requests,
      responses: this.query.responses(actor.workspaceId).filter((response) =>
        typeof response["requestId"] === "string" && requestIds.has(response["requestId"])),
      deliveries,
      sessions,
      attempts,
      environmentRegistrations: this.environments.listRegistrations(actor.workspaceId).filter((registration) =>
        actor.role === "administrator" ||
        registration.allowedProjectIds.some((id) => actor.projectIds.includes(id))),
      environmentBindings: bindings,
      results,
      references: this.query.references(actor.workspaceId).filter((reference) =>
        typeof reference["taskId"] === "string" && taskIds.has(reference["taskId"])),
      output: this.query.output(actor.workspaceId).filter((item) =>
        typeof item["sessionId"] === "string" && sessionIds.has(item["sessionId"]) && (actor.role !== 'runtime' || item['attemptId'] === actor.attemptId)),
      operations,
      profiles: this.execution.listProfiles(actor.workspaceId).filter((profile) => actor.role === 'administrator' || actor.profileIds.includes(profile.id)),
      dashboard: {
        answerNeeded: openRequests.filter((request) => request.kind === 'question'),
        approvalNeeded: openRequests.filter((request) => request.kind === 'approval'),
        deliveryProblems: deliveries.filter((delivery) => ['unknown', 'rejected', 'suppressed'].includes(String(delivery['status']))),
        activeAttempts: attempts.filter((attempt) => attempt.unresolved && (attempt.role === 'primary' || sessions.some((session) => session.id === attempt.sessionId && session.lifecycle === 'open'))),
        resultsToReview: results.filter((result) => tasks.some((task) => task.id === result.taskId && !['done', 'canceled'].includes(task.status))),
        operationalIssues: operations.filter((operation) => ['unknown', 'failed', 'rejected'].includes(String(operation['status']))),
        snapshotCursor: this.query.watermark(actor.workspaceId),
      },
    };
  }

  private canActOnRequest(actor: Actor, request: RequestView): boolean {
    const kind = request.recipient["kind"];
    if (kind === "user") return request.recipient["userId"] === actor.id;
    if (kind === "project_members") {
      return request.recipient["projectId"] === request.projectId &&
        (actor.role === "administrator" || actor.projectIds.includes(request.projectId));
    }
    if (kind === "agent_session") {
      return actor.role === "runtime" && request.recipient["sessionId"] === actor.sessionId;
    }
    return false;
  }
}
