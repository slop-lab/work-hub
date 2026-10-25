import type { AgentRuntimeConnector, ExecutionConnector } from "../contracts/index.ts";
import type { Actor } from "../domain/authorization.ts";
import { parseHubCommand } from "../domain/commands.ts";
import { forbidden } from "../domain/errors.ts";
import type { HubCommandReceipt, HubSnapshot } from "../domain/model.ts";
import { AttemptFactory } from "../persistence/attempt-factory.ts";
import type { Clock } from "../persistence/codec.ts";
import { Store } from "../persistence/database.ts";
import { EnvironmentRepository } from "../persistence/environment-repository.ts";
import { ExecutionRepository } from "../persistence/execution-repository.ts";
import { InteractionRepository } from "../persistence/interaction-repository.ts";
import { OperationRepository } from "../persistence/operation-repository.ts";
import { QueryRepository } from "../persistence/query-repository.ts";
import { ResultRepository } from "../persistence/result-repository.ts";
import { StateRepository } from "../persistence/state-repository.ts";
import { WorkRepository } from "../persistence/work-repository.ts";
import { CommandService } from "../commands/service.ts";
import { ContinuationHandler } from "../commands/continuation-handler.ts";
import { ExecutionHandler } from "../commands/execution-handler.ts";
import { InteractionHandler } from "../commands/interaction-handler.ts";
import { WorkHandler } from "../commands/work-handler.ts";
import { Administration, adminCommandSchema } from "../administration/index.ts";
import { exportSafeRecords } from "../artifacts/export.ts";
import { ReferenceRepository } from '../artifacts/references.ts';
import { EventRepository } from '../persistence/events.ts';
import { createSimulators } from "../simulator/index.ts";
import type { RuntimeProfile, SimulatorCallLog, SimulatorControls, Simulators } from "../simulator/index.ts";
import { ConnectorRegistry, type ConnectorSet } from "./connectors.ts";
import { DelegationWorker } from "./delegation-worker.ts";
import { ExecutionWorker } from "./execution-worker.ts";
import { QueryService, type TaskListQuery } from "./query-service.ts";
import { ReconcileWorker } from "./reconcile-worker.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { OrchestrationWorker } from "./worker.ts";

export type { Actor } from "../domain/authorization.ts";
export type { HubCommand } from "../domain/commands.ts";
export type { HubCommandReceipt, HubSnapshot } from "../domain/model.ts";
export type { TaskListQuery } from "./query-service.ts";

export type HubOptions = {
  readonly clock?: Clock;
  readonly mode?: "simulator" | "external";
  readonly runtimeProfile?: RuntimeProfile;
  readonly connectors?: {
    readonly execution?: Readonly<Record<string, ExecutionConnector>>;
    readonly runtime?: Readonly<Record<string, AgentRuntimeConnector>>;
  };
};

export class Hub {
  readonly readiness: {
    readonly coreReady: boolean;
    readonly liveIntegrationReady: boolean;
    readonly simulated: boolean;
  };
  readonly simulator: {
    readonly controls: SimulatorControls;
    readonly calls: SimulatorCallLog;
  } | undefined;
  readonly administration: Administration;
  private readonly store: Store;
  private readonly commands: CommandService;
  private readonly queries: QueryService;
  private readonly worker: OrchestrationWorker;
  private readonly interactions: InteractionRepository;
  private readonly simulators: Simulators | undefined;
  private readonly references: ReferenceRepository;
  private readonly eventLog: EventRepository;

  constructor(path: string, options: HubOptions = {}) {
    this.store = options.clock === undefined ? new Store(path) : new Store(path, options.clock);
    this.references = new ReferenceRepository(this.store);
    this.eventLog = new EventRepository(this.store.database);
    const work = new WorkRepository(this.store.database, this.store.clock);
    const interactions = new InteractionRepository(this.store.database, this.store.clock);
    const execution = new ExecutionRepository(this.store.database, this.store.clock);
    const environments = new EnvironmentRepository(this.store.database, this.store.clock);
    const results = new ResultRepository(this.store.database, this.store.clock);
    const operations = new OperationRepository(this.store.database, this.store.clock);
    const state = new StateRepository(this.store.database, this.store.clock);
    const query = new QueryRepository(this.store.database);
    const attempts = new AttemptFactory(this.store.database, this.store.clock, execution);
    const useSimulator = options.mode !== "external";
    this.simulators = useSimulator
      ? createSimulators(path, options.runtimeProfile === undefined ? {} : { runtimeProfile: options.runtimeProfile })
      : undefined;
    const connectors = new ConnectorRegistry(this.connectorSet(options, this.simulators));
    this.administration = new Administration(this.store, { runtimeSupports: (id, names) => connectors.runtimeSupports(id, names) });
    const workHandler = new WorkHandler(work, execution, results, state);
    const interactionHandler = new InteractionHandler(interactions, operations, () => this.store.clock.now());
    const executionHandler = new ExecutionHandler({
      work, execution, attempts, environments, interactions, operations, state,
      installationUsable: (workspaceId, kind, id) => this.administration.installations.list({
        id: "system", workspaceId, role: "administrator",
        projectIds: [], profileIds: [], bindingIds: [],
      }).some((installation) => installation.kind === kind && installation.id === id &&
        installation.available && installation.enabled),
      runtimeSupports: (id, names) => connectors.runtimeSupports(id, names),
    });
    const continuationHandler = new ContinuationHandler({
      work,
      execution,
      attempts,
      operations,
      environments,
      results,
      state,
      installationUsable: (workspaceId, id) => this.administration.installations.list({
        id: "system", workspaceId, role: "administrator",
        projectIds: [], profileIds: [], bindingIds: [],
      }).some((installation) => installation.kind === "agent_runtime" &&
        installation.id === id && installation.available && installation.enabled),
      runtimeSupports: (id, names) => connectors.runtimeSupports(id, names),
      now: () => this.store.clock.now(),
    });
    this.commands = new CommandService({
      store: this.store, operations, work: workHandler, interactions: interactionHandler,
      execution: executionHandler, continuations: continuationHandler,
      administration: this.administration,
    });
    this.queries = new QueryService({
      work, interactions, execution, environments, results, operations, query,
    });
    const delegationWorker = new DelegationWorker({
      connectors, operations, environments, execution, state,
    });
    const runtimeWorker = new RuntimeWorker({
      connectors, operations, state, execution, attempts, work, interactions,
    });
    const executionWorker = new ExecutionWorker({ connectors, operations, environments });
    const reconcileWorker = new ReconcileWorker({
      connectors, state, execution, interactions, results,
    });
    this.worker = new OrchestrationWorker({
      connectors, operations, delegation: delegationWorker, runtime: runtimeWorker,
      execution: executionWorker, reconciliation: reconcileWorker,
    });
    this.interactions = interactions;
    this.readiness = {
      coreReady: false,
      liveIntegrationReady: false,
      simulated: useSimulator,
    };
    if (this.simulators !== undefined) {
      this.simulator = { controls: this.simulators.controls, calls: this.simulators.calls };
    } else {
      this.simulator = undefined;
    }
  }

  async execute(actor: Actor, input: unknown): Promise<HubCommandReceipt> {
    const admin = this.tryAdminCommand(input);
    if (admin !== undefined) {
      return this.commands.execute(actor, admin.command);
    }
    return this.commands.execute(actor, parseHubCommand(input));
  }

  actorForUser(id: string): Actor | undefined { return this.administration.users.actorForUser(id); }

  getTask(actor: Actor, id: string) { return this.queries.getTask(actor, id); }
  getReference(actor: Actor, id: string) { return this.references.get(actor, id); }
  listTasks(actor: Actor, query: TaskListQuery = {}) { return this.queries.listTasks(actor, query); }
  getRequest(actor: Actor, id: string) { return this.queries.getRequest(actor, id); }
  getSession(actor: Actor, id: string) { return this.queries.getSession(actor, id); }
  getOutput(actor: Actor, id: string, query: { readonly after: number; readonly limit: number }) { return this.queries.getOutput(actor, id, query); }
  getEnvironmentRegistration(actor: Actor, id: string) {
    return this.queries.getEnvironmentRegistration(actor, id);
  }
  getEnvironmentBinding(actor: Actor, id: string) { return this.queries.getEnvironmentBinding(actor, id); }
  getCommandReceipt(actor: Actor, id: string) { return this.queries.getCommandReceipt(actor, id); }
  getDashboard(actor: Actor) { return this.queries.dashboard(actor); }
  events(actor: Actor, input: { readonly after: number; readonly limit?: number }) {
    const snapshot = this.snapshot(actor);
    const permittedIds = new Set([...snapshot.tasks, ...snapshot.requests, ...snapshot.sessions, ...snapshot.attempts, ...snapshot.environmentBindings, ...snapshot.environmentRegistrations, ...snapshot.results].map((record) => record.id));
    return this.eventLog.list(actor, { after: input.after, limit: Math.max(1, Math.min(input.limit ?? 100, 100)), permittedIds });
  }
  snapshot(actor: Actor): HubSnapshot { return this.queries.snapshot(actor); }

  bridgeResponses(actor: Actor, input: { readonly after?: string } = {}) {
    if (actor.role !== "runtime" || actor.sessionId === undefined) {
      throw forbidden("Bridge response polling requires a scoped runtime principal.");
    }
    return this.interactions.bridgeResponses({
      workspaceId: actor.workspaceId, sessionId: actor.sessionId,
      ...(actor.attemptId === undefined ? {} : { attemptId: actor.attemptId }),
      ...(actor.bindingGeneration === undefined ? {} : { bindingGeneration: actor.bindingGeneration }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }

  drain(input: { readonly limit?: number } = {}): Promise<number> { return this.worker.drain(input); }
  reconcile(input: { readonly limit?: number } = {}): Promise<number> { return this.worker.reconcile(input); }

  exportRecords(actor: Actor): string {
    return JSON.stringify(exportSafeRecords({ contractVersion: "work-hub-export.v1", exportedAt: this.store.clock.now().toISOString(),
      workspaceId: actor.workspaceId, records: this.snapshot(actor) }));
  }

  close(): void {
    this.simulators?.close();
    this.store.close();
  }

  private connectorSet(options: HubOptions, simulators: Simulators | undefined): ConnectorSet {
    const execution = { ...(options.connectors?.execution ?? {}) };
    const runtime = { ...(options.connectors?.runtime ?? {}) };
    if (simulators !== undefined) {
      execution["execution-sim"] = simulators.execution;
      runtime["runtime-sim-structured"] = simulators.runtimeFor('structured');
      runtime["runtime-sim-limited"] = simulators.runtimeFor('limited_bridge');
    }
    return { execution, runtime };
  }

  private tryAdminCommand(input: unknown) {
    const parsed = adminCommandSchema.safeParse(input);
    return parsed.success ? { command: parsed.data } : undefined;
  }
}
