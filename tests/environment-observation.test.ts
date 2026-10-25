import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRuntimeConnector, BindingObservation, ExecutionConnector, OutputPage } from "../application/contracts/index.ts";
import { ConnectorRegistry } from "../application/orchestration/connectors.ts";
import { ReconcileWorker } from "../application/orchestration/reconcile-worker.ts";
import { EnvironmentRepository } from "../application/persistence/environment-repository.ts";
import { ExecutionRepository } from "../application/persistence/execution-repository.ts";
import { InteractionRepository } from "../application/persistence/interaction-repository.ts";
import { ResultRepository } from "../application/persistence/result-repository.ts";
import { ObservationRepository } from "../application/persistence/observation-repository.ts";
import { StateRepository } from "../application/persistence/state-repository.ts";
import { Store } from "../application/persistence/database.ts";
import { createSimulators } from "../application/simulator/index.ts";

const observedAt = "2026-10-25T00:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "work-hub-environment-observation-"));
  const path = join(directory, "hub.sqlite");
  const store = new Store(path);
  return { store, simulators: createSimulators(path) };
}

function seedAttachedBinding(store: Store, suffix: string): void {
  const sessionId = `session:${suffix}`;
  const attemptId = `attempt:${suffix}`;
  const identity = { native: { installationId: "execution-sim", providerScope: "test",
    kind: "environment", id: `environment:${suffix}`, incarnation: "v1" }, assurance: "immutable",
    continuityToken: `continuity:${suffix}:v1` };
  const attachment = { hubBindingId: `binding:${suffix}`, hubBindingGeneration: 1,
    attachmentRef: { installationId: "execution-sim", providerScope: "test", kind: "attachment",
      id: `attachment:${suffix}`, incarnation: "1" }, identity, origin: "registered_existing",
    routes: [], useGrant: { id: `use:${suffix}`, allowedWorkAreas: [], runtimeServiceLaunch: false,
      enforcement: "enforced", exclusivity: "hub_only", limitations: [] } };
  const nativeSession = { installationId: "runtime-sim-structured", providerScope: "test",
    kind: "session", id: `native:${suffix}`, incarnation: "v1" };
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
      'attached', ?, ?)`).run(
    `binding:${suffix}`, sessionId, attemptId, `registration:${suffix}`, JSON.stringify(identity),
    JSON.stringify(attachment), JSON.stringify(attachment.useGrant), observedAt, observedAt,
  );
}

function proxyMethod<T extends object>(base: T, name: PropertyKey, method: unknown): T {
  return new Proxy(base, {
    get(target, property, receiver) {
      return property === name ? method : Reflect.get(target, property, receiver);
    },
  });
}

test("changed identity and missing grants make active environment bindings unsafe and attempts stale", async () => {
  // Given
  const { store, simulators } = await fixture();
  seedAttachedBinding(store, "replaced");
  seedAttachedBinding(store, "grant-lost");
  const runtime = proxyMethod<AgentRuntimeConnector>(simulators.runtime, "inspectSession",
    async (context: Parameters<AgentRuntimeConnector["inspectSession"]>[0], target: Parameters<AgentRuntimeConnector["inspectSession"]>[1]) => ({
      value: { nativeSession: target.nativeSession, exists: true, execution: { phase: "running" as const,
        hubAttemptId: `attempt:${target.hubSessionId.split(":").at(-1)}`, pendingNativeRequestRefs: [] },
        controlGrantValid: true, limitations: [] }, sourceInstallationId: context.installationId,
      observedAt, assurance: "authoritative" as const, limitations: [],
    }));
  const runtimeWithoutOutput = proxyMethod(runtime, "readOutput",
    async (): Promise<OutputPage> => ({ items: [], coverage: "partial", gaps: [] }));
  const execution = proxyMethod<ExecutionConnector>(simulators.execution, "inspectBinding",
    async (_context: Parameters<ExecutionConnector["inspectBinding"]>[0], attachment: Parameters<ExecutionConnector["inspectBinding"]>[1]) => {
      const grantLost = attachment.hubBindingId === "binding:grant-lost";
      const value: BindingObservation = {
        identity: grantLost ? attachment.identity : { ...attachment.identity,
          native: { ...attachment.identity.native, incarnation: "v2" },
          continuityToken: "replacement:v2" },
        state: grantLost ? "running" : "missing", attachmentValid: grantLost,
        grantValid: false, knownExternalActivity: "unknown",
        limitations: [grantLost ? "grant_revoked" : "identity_replaced"],
      };
      return { value, sourceInstallationId: "execution-sim", observedAt,
        assurance: "authoritative" as const, limitations: [] };
    });
  const environments = new EnvironmentRepository(store.database, store.clock);
  const reconciliation = new ReconcileWorker({
    connectors: new ConnectorRegistry({ execution: { "execution-sim": execution },
      runtime: { "runtime-sim-structured": runtimeWithoutOutput } }),
    state: new StateRepository(store.database, store.clock),
    observation: new ObservationRepository(store.database, store.clock),
    execution: new ExecutionRepository(store.database, store.clock),
    interactions: new InteractionRepository(store.database, store.clock),
    results: new ResultRepository(store.database, store.clock),
  });

  // When
  await reconciliation.run(10);

  // Then
  for (const suffix of ["replaced", "grant-lost"] as const) {
    const attempt = new ExecutionRepository(store.database, store.clock)
      .getAttempt("workspace-default", `attempt:${suffix}`);
    const binding = store.database.prepare(`SELECT observation_json AS observationJson
      FROM environment_bindings WHERE workspace_id = ? AND id = ?`)
      .get("workspace-default", `binding:${suffix}`);
    const observationJson = Reflect.get(binding ?? {}, "observationJson");
    assert.equal(attempt.observation, "stale");
    assert.equal(typeof observationJson, "string");
    assert.equal(Reflect.get(JSON.parse(String(observationJson)), "safety"), "unsafe");
  }
  simulators.close();
  store.close();
});

test("unsafe environment observation follows the session to its current continuation attempt", async () => {
  // Given
  const { store, simulators } = await fixture();
  seedAttachedBinding(store, "continued");
  store.database.prepare(`UPDATE attempts SET phase = 'finished', outcome = 'result_submitted',
    unresolved = 0 WHERE id = 'attempt:continued'`).run();
  store.database.prepare(`INSERT INTO attempts
    (id, workspace_id, task_id, session_id, profile_id, profile_revision, role, origin,
     phase, observation, input_snapshot_json, predecessor_id, unresolved, business_intent_epoch,
     created_at, updated_at)
    VALUES ('attempt:continued:next', 'workspace-default', 'task:continued', 'session:continued',
      'profile-structured', 1, 'primary', 'hub_started', 'running', 'fresh', '{}',
      'attempt:continued', 1, 0, ?, ?)`).run(observedAt, observedAt);
  store.database.prepare(`UPDATE sessions SET active_attempt_id = 'attempt:continued:next'
    WHERE id = 'session:continued'`).run();
  const observations = new ObservationRepository(store.database, store.clock);

  // When
  observations.saveEnvironmentObservation({ workspaceId: "workspace-default",
    bindingId: "binding:continued", observation: { message: "environment identity replaced" },
    safety: "unsafe" });

  // Then
  const continuation = new ExecutionRepository(store.database, store.clock)
    .getAttempt("workspace-default", "attempt:continued:next");
  assert.equal(continuation.observation, "stale");
  assert.equal(observations.environmentSafety("workspace-default", "session:continued"), "unsafe");
  simulators.close();
  store.close();
});
