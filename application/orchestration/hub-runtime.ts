import type { AgentRuntimeConnector, ExecutionConnector } from "../contracts/index.ts";
import { Administration } from "../administration/index.ts";
import { CommandService } from "../commands/service.ts";
import { ContinuationHandler } from "../commands/continuation-handler.ts";
import { ExecutionHandler } from "../commands/execution-handler.ts";
import { InteractionHandler } from "../commands/interaction-handler.ts";
import { LifecycleHandler } from "../commands/lifecycle-handler.ts";
import { WorkHandler } from "../commands/work-handler.ts";
import { unsupported } from "../domain/errors.ts";
import { AttemptFactory } from "../persistence/attempt-factory.ts";
import { AttachedHandoffFactory } from "../persistence/attached-handoff.ts";
import type { Clock } from "../persistence/codec.ts";
import type { Store } from "../persistence/database.ts";
import { EnvironmentRepository } from "../persistence/environment-repository.ts";
import { ExecutionRepository } from "../persistence/execution-repository.ts";
import { HandoffRepository } from "../persistence/handoff-repository.ts";
import { InteractionRepository } from "../persistence/interaction-repository.ts";
import { LifecycleRepository } from "../persistence/lifecycle-repository.ts";
import { ObservationRepository } from "../persistence/observation-repository.ts";
import { OperationRepository } from "../persistence/operation-repository.ts";
import { QueryRepository } from "../persistence/query-repository.ts";
import { ResultRepository } from "../persistence/result-repository.ts";
import { StateRepository } from "../persistence/state-repository.ts";
import { WorkRepository } from "../persistence/work-repository.ts";
import { createSimulators, type RuntimeProfile, type Simulators } from "../simulator/index.ts";
import { BridgeQueries } from "./bridge-queries.ts";
import { ConnectorRegistry } from "./connectors.ts";
import { DelegationWorker } from "./delegation-worker.ts";
import { ExecutionWorker } from "./execution-worker.ts";
import { HandoffService } from "./handoff-service.ts";
import { QueryService } from "./query-service.ts";
import { ReconcileWorker } from "./reconcile-worker.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { OrchestrationWorker } from "./worker.ts";

export type HubRuntimeOptions = {
  readonly clock?: Clock;
  readonly mode?: "simulator" | "external";
  readonly runtimeProfile?: RuntimeProfile;
  readonly connectors?: {
    readonly execution?: Readonly<Record<string, ExecutionConnector>>;
    readonly runtime?: Readonly<Record<string, AgentRuntimeConnector>>;
  };
};

export function createHubRuntime(path: string, store: Store, options: HubRuntimeOptions) {
  const work = new WorkRepository(store.database, store.clock);
  const interactions = new InteractionRepository(store.database, store.clock);
  const execution = new ExecutionRepository(store.database, store.clock);
  const handoffs = new HandoffRepository(store.database, store.clock);
  const environments = new EnvironmentRepository(store.database, store.clock);
  const results = new ResultRepository(store.database, store.clock);
  const lifecycle = new LifecycleRepository(store.database, store.clock);
  const operations = new OperationRepository(store.database, store.clock);
  const observation = new ObservationRepository(store.database, store.clock);
  const state = new StateRepository(store.database, store.clock);
  const query = new QueryRepository(store.database);
  const attempts = new AttemptFactory(store.database, store.clock, execution);
  const attachedHandoffs = new AttachedHandoffFactory({ database: store.database,
    clock: store.clock, execution, handoffs });
  const useSimulator = options.mode !== "external";
  const simulators = useSimulator
    ? createSimulators(path, options.runtimeProfile === undefined ? {} : { runtimeProfile: options.runtimeProfile })
    : undefined;
  const connectors = new ConnectorRegistry({
    execution: { ...(options.connectors?.execution ?? {}),
      ...(simulators === undefined ? {} : { "execution-sim": simulators.execution }) },
    runtime: { ...(options.connectors?.runtime ?? {}),
      ...(simulators === undefined ? {} : {
        "runtime-sim-structured": simulators.runtimeFor("structured"),
        "runtime-sim-limited": simulators.runtimeFor("limited_bridge"),
      }) },
  });
  const administration = new Administration(store, {
    runtimeSupports: (id, names) => connectors.runtimeSupports(id, names),
    connectorAvailable: (kind, id) => connectors.available(kind, id),
  });
  const installationUsable = (workspaceId: string, kind: "execution" | "agent_runtime", id: string) => {
    if (!connectors.available(kind, id)) return false;
    return administration.installations.list({ id: "system", workspaceId, role: "administrator",
      projectIds: [], profileIds: [], bindingIds: [] }).some((installation) =>
      installation.kind === kind && installation.id === id && installation.available && installation.enabled);
  };
  const executionHandler = new ExecutionHandler({ work, execution, attempts, environments,
    interactions, operations, state, handoffs, attachedHandoffs, lifecycle,
    installationUsable: (workspaceId, kind, id) => {
      if (!connectors.available(kind, id)) throw unsupported("connector_unavailable",
        `Connector installation ${id} is not configured or compatible.`);
      return installationUsable(workspaceId, kind, id);
    }, runtimeSupports: (id, names) => connectors.runtimeSupports(id, names) });
  const commands = new CommandService({ store, operations,
    work: new WorkHandler({ work, execution, results, state, lifecycle }),
    interactions: new InteractionHandler(interactions, operations, () => store.clock.now()),
    lifecycle: new LifecycleHandler({ lifecycle, work, execution, results }),
    execution: executionHandler,
    continuations: new ContinuationHandler({ work, execution, attempts, operations, environments,
      observation, results, state, handoffs, lifecycle, installationUsable,
      runtimeSupports: (id, names) => connectors.runtimeSupports(id, names), now: () => store.clock.now() }),
    administration });
  const queries = new QueryService({ work, interactions, execution, environments, results,
    operations, query, lifecycle });
  const delegation = new DelegationWorker({ connectors, operations, environments, execution, state });
  const runtime = new RuntimeWorker({ connectors, operations, state, execution, attempts, work,
    interactions, handoffs });
  const executionWorker = new ExecutionWorker({ connectors, operations, environments });
  const reconciliation = new ReconcileWorker({ connectors, state, observation, execution,
    interactions, results, lifecycle, work });
  const worker = new OrchestrationWorker({ connectors, operations, delegation, runtime,
    execution: executionWorker, reconciliation, terminalFailure: (item, receipt) => {
      if (["delegation.advance", "execution.attachForDelegation", "session.attachEnvironment",
        "runtime.openForDelegation"].includes(item.operationKind)) return delegation.applyFailure(item);
      if (["runtime.startAttempt", "runtime.sendInstruction", "runtime.deliverResponse",
        "runtime.requestStop", "session.attachExisting", "runtime.requestControl",
        "runtime.detachSession"].includes(item.operationKind)) return runtime.applyFailure(item, receipt);
      if (["execution.detachAttachment", "execution.releaseAllocation", "execution.cancelOperation",
        "execution.releaseCanceledAllocation", "execution.detachCanceledAttachment"]
        .includes(item.operationKind)) return executionWorker.applyFailure(item);
      throw new TypeError(`No terminal failure reducer for ${item.operationKind}.`);
    } });
  return { administration, commands, queries, worker,
    bridge: new BridgeQueries(store.database, interactions), simulators,
    handoffService: new HandoffService({ execution, handoffs, work, results }), useSimulator };
}
