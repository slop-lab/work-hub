import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentRuntimeConnector,
  CallContext,
  OutputPage,
  RuntimeEvent,
  RuntimeSessionObservation,
} from "../application/contracts/index.ts";
import { ConnectorRegistry } from "../application/orchestration/connectors.ts";
import { ReconcileWorker } from "../application/orchestration/reconcile-worker.ts";
import { ExecutionRepository } from "../application/persistence/execution-repository.ts";
import { InteractionRepository } from "../application/persistence/interaction-repository.ts";
import { ResultRepository } from "../application/persistence/result-repository.ts";
import { ObservationRepository } from "../application/persistence/observation-repository.ts";
import { StateRepository } from "../application/persistence/state-repository.ts";
import { Store } from "../application/persistence/database.ts";
import { createSimulators } from "../application/simulator/index.ts";

const observedAt = "2026-10-25T00:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "work-hub-runtime-observation-"));
  const path = join(directory, "hub.sqlite");
  const store = new Store(path);
  const simulators = createSimulators(path);
  return { store, simulators };
}

function seedBinding(store: Store, sessionId: string, lifecycle: "open" | "closed" = "open"): void {
  const nativeSession = {
    installationId: "runtime-sim-structured", providerScope: "test", kind: "session",
    id: `native:${sessionId}`, incarnation: "v1",
  };
  const descriptor = {
    nativeSession, nativeIdentityAssurance: "immutable", origin: "created",
    route: { id: `route:${sessionId}`, ownerInstallationId: "runtime-sim-structured", kind: "test" },
    controlGrant: { id: `grant:${sessionId}`, mode: "control", allowedActions: [],
      externalClientsMayAlsoControl: false },
    capabilities: {}, history: "partial",
  };
  store.database.prepare(`INSERT INTO sessions
    (id, workspace_id, project_id, task_id, revision, runtime_installation_id,
     native_identity_key, lifecycle, control_mode, binding_generation, active_attempt_id,
     capabilities_json, created_at, updated_at)
    VALUES (?, 'workspace-default', 'project-default', ?, 1, 'runtime-sim-structured', ?, ?,
      'control', 1, ?, '{}', ?, ?)`).run(
    sessionId, `task:${sessionId}`, JSON.stringify(nativeSession), lifecycle,
    `attempt:${sessionId}`, observedAt, observedAt,
  );
  store.database.prepare(`INSERT INTO attempts
    (id, workspace_id, task_id, session_id, profile_id, profile_revision, role, origin,
     phase, observation, input_snapshot_json, unresolved, business_intent_epoch, created_at, updated_at)
    VALUES (?, 'workspace-default', ?, ?, 'profile-structured', 1, 'primary', 'hub_started',
      'running', 'fresh', '{}', 1, 0, ?, ?)`).run(
    `attempt:${sessionId}`, `task:${sessionId}`, sessionId, observedAt, observedAt,
  );
  store.database.prepare(`INSERT INTO runtime_bindings
    (session_id, workspace_id, descriptor_json, generation, created_at, updated_at)
    VALUES (?, 'workspace-default', ?, 1, ?, ?)`).run(
    sessionId, JSON.stringify(descriptor), observedAt, observedAt,
  );
}

function runtimeProxy(
  base: AgentRuntimeConnector,
  overrides: {
    readonly inspectSession?: AgentRuntimeConnector["inspectSession"];
    readonly readOutput?: AgentRuntimeConnector["readOutput"];
    readonly subscribe?: AgentRuntimeConnector["subscribe"];
  },
): AgentRuntimeConnector {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "inspectSession" && overrides.inspectSession !== undefined) {
        return overrides.inspectSession;
      }
      if (property === "readOutput" && overrides.readOutput !== undefined) return overrides.readOutput;
      if (property === "subscribe" && overrides.subscribe !== undefined) return overrides.subscribe;
      return Reflect.get(target, property, receiver);
    },
  });
}

function observation(sessionId: string): RuntimeSessionObservation {
  return {
    nativeSession: { installationId: "runtime-sim-structured", providerScope: "test",
      kind: "session", id: `native:${sessionId}`, incarnation: "v1" },
    exists: true, execution: { hubAttemptId: `attempt:${sessionId}`, phase: "running",
      pendingNativeRequestRefs: [] }, controlGrantValid: true, limitations: [],
  };
}

function worker(store: Store, runtime: AgentRuntimeConnector, input: {
  readonly subscriptionBudgetMs?: number;
  readonly maxEventsPerBinding?: number;
} = {}): ReconcileWorker {
  return new ReconcileWorker({
    connectors: new ConnectorRegistry({ execution: {}, runtime: { "runtime-sim-structured": runtime } }),
    state: new StateRepository(store.database, store.clock),
    observation: new ObservationRepository(store.database, store.clock),
    execution: new ExecutionRepository(store.database, store.clock),
    interactions: new InteractionRepository(store.database, store.clock),
    results: new ResultRepository(store.database, store.clock),
    ...input,
  });
}

test("output and event observation persist independent opaque cursors", async () => {
  // Given
  const { store, simulators } = await fixture();
  seedBinding(store, "cursor-session");
  const outputAfter: (string | undefined)[] = [];
  const eventAfter: (string | undefined)[] = [];
  let cycle = 0;
  const runtime = runtimeProxy(simulators.runtime, {
    inspectSession: async (context, target) => ({ value: observation(target.hubSessionId),
      sourceInstallationId: context.installationId, observedAt, assurance: "authoritative", limitations: [] }),
    readOutput: async (_context, input): Promise<OutputPage> => {
      outputAfter.push(input.after);
      return cycle === 0 ? { items: [{ sourceItemId: "unrelated-output-id", kind: "message",
        role: "agent", text: "one", observedAt }], nextCursor: "opaque-output-cursor",
        coverage: "partial", gaps: [] } : { items: [], coverage: "partial", gaps: [] };
    },
    subscribe: async function* (_context, input): AsyncIterable<RuntimeEvent> {
      eventAfter.push(input.after);
      if (cycle === 0) yield { sourceEventId: "unrelated-event-id", sourceCursor: "opaque-event-cursor",
        streamScope: "cursor-session", nativeSession: observation("cursor-session").nativeSession,
        bindingGeneration: 1, observedAt, payload: { type: "extension", namespace: "test", data: {} } };
    },
  });
  // When
  await worker(store, runtime).run(1);
  cycle += 1;
  await worker(store, runtime).run(1);

  // Then
  assert.deepEqual(outputAfter, [undefined, "opaque-output-cursor"]);
  assert.deepEqual(eventAfter, [undefined, "opaque-event-cursor"]);
  simulators.close();
  store.close();
});

test("a never-ending subscription is aborted within the observation budget", async () => {
  // Given
  const { store, simulators } = await fixture();
  seedBinding(store, "blocking-session");
  let subscriptionAborted = false;
  const runtime = runtimeProxy(simulators.runtime, {
    inspectSession: async (context, target) => ({ value: observation(target.hubSessionId),
      sourceInstallationId: context.installationId, observedAt, assurance: "authoritative", limitations: [] }),
    readOutput: async (): Promise<OutputPage> => ({ items: [], coverage: "partial", gaps: [] }),
    subscribe: (context: CallContext): AsyncIterable<RuntimeEvent> => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
            context.signal?.addEventListener("abort", () => {
              subscriptionAborted = true;
              resolve({ done: true, value: undefined });
            }, { once: true });
          }),
        };
      },
    }),
  });

  // When
  const count = await worker(store, runtime, { subscriptionBudgetMs: 10 }).run(1);

  // Then
  assert.equal(count, 1);
  assert.equal(subscriptionAborted, true);
  simulators.close();
  store.close();
});

test("closed history cannot starve active bindings and active bindings rotate fairly", async () => {
  // Given
  const { store, simulators } = await fixture();
  seedBinding(store, "00-closed", "closed");
  seedBinding(store, "10-active");
  seedBinding(store, "20-active");
  const inspected: string[] = [];
  const runtime = runtimeProxy(simulators.runtime, {
    inspectSession: async (context, target) => {
      inspected.push(target.hubSessionId);
      return { value: observation(target.hubSessionId), sourceInstallationId: context.installationId,
        observedAt, assurance: "authoritative", limitations: [] };
    },
    readOutput: async (): Promise<OutputPage> => ({ items: [], coverage: "partial", gaps: [] }),
    subscribe: async function* (): AsyncIterable<RuntimeEvent> {},
  });
  const reconciliation = worker(store, runtime);

  // When
  await reconciliation.run(1);
  await reconciliation.run(1);

  // Then
  assert.deepEqual(inspected, ["10-active", "20-active"]);
  simulators.close();
  store.close();
});

test("late running observation cannot reopen a terminal attempt", async () => {
  // Given
  const { store, simulators } = await fixture();
  seedBinding(store, "terminal-session");
  store.database.prepare(`UPDATE attempts SET phase = 'finished', outcome = 'failed', unresolved = 0
    WHERE id = 'attempt:terminal-session'`).run();
  const runtime = runtimeProxy(simulators.runtime, {
    inspectSession: async (context, target) => ({ value: observation(target.hubSessionId),
      sourceInstallationId: context.installationId, observedAt, assurance: "authoritative", limitations: [] }),
    readOutput: async (): Promise<OutputPage> => ({ items: [], coverage: "partial", gaps: [] }),
    subscribe: async function* (): AsyncIterable<RuntimeEvent> {},
  });

  // When
  await worker(store, runtime).run(1);

  // Then
  const attempt = new ExecutionRepository(store.database, store.clock)
    .getAttempt("workspace-default", "attempt:terminal-session");
  assert.equal(attempt.phase, "finished");
  assert.equal(attempt.outcome, "failed");
  simulators.close();
  store.close();
});
