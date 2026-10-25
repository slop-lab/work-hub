import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRuntimeConnector, BindingObservation, ExecutionConnector, OutputPage, RuntimeEvent } from "../application/contracts/index.ts";
import { ConnectorRegistry } from "../application/orchestration/connectors.ts";
import { ReconcileWorker } from "../application/orchestration/reconcile-worker.ts";
import { Store } from "../application/persistence/database.ts";
import { ExecutionRepository } from "../application/persistence/execution-repository.ts";
import { InteractionRepository } from "../application/persistence/interaction-repository.ts";
import { ObservationRepository } from "../application/persistence/observation-repository.ts";
import { ResultRepository } from "../application/persistence/result-repository.ts";
import { StateRepository } from "../application/persistence/state-repository.ts";
import { createSimulators } from "../application/simulator/index.ts";

const observedAt = "2026-10-25T00:00:00.000Z";

function proxyMethod<T extends object>(base: T, name: PropertyKey, method: unknown): T {
  return new Proxy(base, { get: (target, property, receiver) =>
    property === name ? method : Reflect.get(target, property, receiver) });
}

function seed(store: Store, suffix: string): void {
  const sessionId = `session:${suffix}`;
  const attemptId = `attempt:${suffix}`;
  const nativeSession = { installationId: "runtime-sim-structured", providerScope: "test",
    kind: "session", id: `native:${suffix}`, incarnation: "v1" };
  const identity = { native: { installationId: "execution-sim", providerScope: "test",
    kind: "environment", id: `environment:${suffix}`, incarnation: "v1" }, assurance: "immutable",
    continuityToken: `continuity:${suffix}` };
  const attachment = { hubBindingId: `binding:${suffix}`, hubBindingGeneration: 1,
    attachmentRef: { installationId: "execution-sim", providerScope: "test", kind: "attachment",
      id: `attachment:${suffix}`, incarnation: "1" }, identity, origin: "registered_existing",
    routes: [], useGrant: { id: `use:${suffix}`, allowedWorkAreas: [], runtimeServiceLaunch: false,
      enforcement: "enforced", exclusivity: "hub_only", limitations: [] } };
  const descriptor = { nativeSession, nativeIdentityAssurance: "immutable", origin: "created",
    route: { id: `route:${suffix}`, ownerInstallationId: "runtime-sim-structured", kind: "test" },
    controlGrant: { id: `control:${suffix}`, mode: "control", allowedActions: [],
      externalClientsMayAlsoControl: false }, capabilities: {}, history: "partial" };
  store.database.prepare(`INSERT INTO sessions
    (id, workspace_id, project_id, task_id, revision, runtime_installation_id,
     native_identity_key, lifecycle, control_mode, binding_generation, active_attempt_id,
     capabilities_json, created_at, updated_at)
    VALUES (?, 'workspace-default', 'project-default', ?, 1, 'runtime-sim-structured', ?, 'open',
      'control', 1, ?, '{}', ?, ?)`).run(
    sessionId, `task:${suffix}`, JSON.stringify(nativeSession), attemptId, observedAt, observedAt,
  );
  store.database.prepare(`INSERT INTO attempts
    (id, workspace_id, task_id, session_id, profile_id, profile_revision, role, origin,
     phase, observation, input_snapshot_json, unresolved, business_intent_epoch, created_at, updated_at)
    VALUES (?, 'workspace-default', ?, ?, 'profile-structured', 1, 'primary', 'hub_started',
      'running', 'fresh', '{}', 1, 0, ?, ?)`).run(
    attemptId, `task:${suffix}`, sessionId, observedAt, observedAt,
  );
  store.database.prepare(`INSERT INTO runtime_bindings
    (session_id, workspace_id, descriptor_json, generation, created_at, updated_at)
    VALUES (?, 'workspace-default', ?, 1, ?, ?)`).run(
    sessionId, JSON.stringify(descriptor), observedAt, observedAt,
  );
  store.database.prepare(`INSERT INTO environment_bindings
    (id, workspace_id, session_id, attempt_id, source_kind, source_id, identity_json,
     attachment_json, use_grant_json, work_area_keys_json, access_mode, generation, state,
     created_at, updated_at)
    VALUES (?, 'workspace-default', ?, ?, 'registration', ?, ?, ?, ?, '[]', 'write', 1,
      'attached', ?, ?)`).run(`binding:${suffix}`, sessionId, attemptId, `registration:${suffix}`,
    JSON.stringify(identity), JSON.stringify(attachment), JSON.stringify(attachment.useGrant),
    observedAt, observedAt);
}

test("hung read observations are bounded and cannot starve later runtime or environment bindings", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "work-hub-observation-timeout-"));
  const path = join(root, "hub.sqlite");
  const store = new Store(path);
  const simulators = createSimulators(path);
  for (const suffix of ["00-inspect-hung", "10-live", "20-output-hung"]) seed(store, suffix);
  const inspectedSessions: string[] = [];
  const inspectedEnvironments: string[] = [];
  let boundedContexts = 0;
  const runtimeWithInspect = proxyMethod<AgentRuntimeConnector>(simulators.runtime, "inspectSession",
    (context: Parameters<AgentRuntimeConnector["inspectSession"]>[0], target: Parameters<AgentRuntimeConnector["inspectSession"]>[1]) => {
      if (context.signal !== undefined && context.deadlineAt !== undefined) boundedContexts += 1;
      if (target.hubSessionId === "session:00-inspect-hung") return new Promise(() => {});
      inspectedSessions.push(target.hubSessionId);
      return Promise.resolve({ value: { nativeSession: target.nativeSession, exists: true,
        execution: { phase: "running" as const, hubAttemptId: `attempt:${target.hubSessionId.split(":").at(-1)}`,
          pendingNativeRequestRefs: [] }, controlGrantValid: true, limitations: [] },
        sourceInstallationId: context.installationId, observedAt, assurance: "authoritative" as const,
        limitations: [] });
    });
  const runtimeWithOutput = proxyMethod(runtimeWithInspect, "readOutput",
    (context: Parameters<AgentRuntimeConnector["readOutput"]>[0], input: Parameters<AgentRuntimeConnector["readOutput"]>[1]): Promise<OutputPage> => {
      if (context.signal !== undefined && context.deadlineAt !== undefined) boundedContexts += 1;
      return input.target.hubSessionId === "session:20-output-hung"
        ? new Promise(() => {})
        : Promise.resolve({ items: [], coverage: "partial", gaps: [] });
    });
  const runtime = proxyMethod(runtimeWithOutput, "subscribe",
    async function* (): AsyncIterable<RuntimeEvent> {});
  const execution = proxyMethod<ExecutionConnector>(simulators.execution, "inspectBinding",
    (context: Parameters<ExecutionConnector["inspectBinding"]>[0], attachment: Parameters<ExecutionConnector["inspectBinding"]>[1]) => {
      if (context.signal !== undefined && context.deadlineAt !== undefined) boundedContexts += 1;
      if (attachment.hubBindingId === "binding:00-inspect-hung") return new Promise(() => {});
      inspectedEnvironments.push(attachment.hubBindingId);
      const value: BindingObservation = { identity: attachment.identity, state: "running",
        attachmentValid: true, grantValid: true, knownExternalActivity: "idle", limitations: [] };
      return Promise.resolve({ value, sourceInstallationId: context.installationId, observedAt,
        assurance: "authoritative" as const, limitations: [] });
    });
  const reconciliation = new ReconcileWorker({ connectors: new ConnectorRegistry({
    execution: { "execution-sim": execution }, runtime: { "runtime-sim-structured": runtime },
  }), state: new StateRepository(store.database, store.clock),
  observation: new ObservationRepository(store.database, store.clock),
  execution: new ExecutionRepository(store.database, store.clock),
  interactions: new InteractionRepository(store.database, store.clock),
  results: new ResultRepository(store.database, store.clock), readBudgetMs: 10 });

  // When
  const completed = await Promise.race([
    reconciliation.run(10).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
  ]);

  // Then
  assert.equal(completed, true);
  assert.equal(inspectedSessions.includes("session:10-live"), true);
  assert.equal(inspectedEnvironments.includes("binding:10-live"), true);
  assert.ok(boundedContexts >= 4);
  simulators.close();
  store.close();
});
