import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { StateRepository } from "../application/persistence/state-repository.ts";
import { Store } from "../application/persistence/database.ts";
import {
  createTask, fixture, member,
} from "./acceptance-fixture.ts";

test("explicit reconciliation retires automatic lookup and never reapplies a confirmed reducer", async () => {
  // Given
  const context = fixture();
  try {
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("runtime.openSession", { kind: "unknown_after_effect" });
    const taskId = await createTask(context.hub, "explicit-reconcile-once");
    const delegated = await context.hub.execute(member, {
      commandId: "delegate-explicit-reconcile", type: "attempt.delegate",
      target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
      payload: { profileId: "profile-structured", environment: { mode: "none" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] },
    });
    await context.hub.drain({ limit: 1 });
    const operation = context.hub.snapshot(member).operations?.find((candidate) =>
      candidate["operationKind"] === "delegation.advance" && candidate["status"] === "unknown");
    assert.ok(operation);
    const operationId = String(operation["id"]);
    const database = new DatabaseSync(context.path);
    database.prepare("UPDATE outbox SET next_due_at = '9999-12-31T23:59:59.999Z' WHERE operation_id = ?")
      .run(operationId);
    database.close();

    // When
    const first = await context.hub.execute(member, { commandId: "reconcile-once",
      type: "operation.reconcile", target: { kind: "operation", id: operationId }, payload: {} });
    assert.equal(first.status, "accepted");
    await context.hub.drain({ limit: 1 });
    await context.hub.drain({ limit: 1 });
    const second = await context.hub.execute(member, { commandId: "reconcile-twice",
      type: "operation.reconcile", target: { kind: "operation", id: operationId }, payload: {} });

    // Then
    assert.equal(second.error?.code, "operation_not_unknown");
    const attemptId = delegated.objectRefs[0]?.id;
    assert.ok(attemptId);
    const attempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attemptId);
    assert.equal(attempt?.phase, "running");
    assert.equal(simulator.calls.list().filter((call) => call.operationKind === "runtime.openSession").length, 1);
    assert.equal(simulator.calls.list().filter((call) => call.operationKind === "runtime.startAttempt").length, 1);
    const check = new DatabaseSync(context.path);
    const originalOutbox = check.prepare("SELECT state FROM outbox WHERE operation_id = ?").get(operationId);
    check.close();
    assert.equal(Reflect.get(originalOutbox ?? {}, "state"), "done");
  } finally {
    context.close();
  }
});

test("existing environment probe effects and successor creation roll back together", async () => {
  // Given
  let now = new Date("2026-10-25T00:00:00.000Z");
  const context = fixture({ clock: { now: () => now } });
  try {
    const registered = await context.hub.execute({ ...member, role: "administrator" }, {
      commandId: "register-atomic-probe", type: "environment.register",
      payload: { label: "existing", executionInstallationId: "execution-sim", locator: { name: "existing" },
        allowedProjectIds: ["project-default"], allowedWorkAreas: [], allowRuntimeServiceLaunch: false },
    });
    const registrationId = registered.objectRefs[0]?.id;
    assert.ok(registrationId);
    await context.hub.execute({ ...member, role: "administrator" }, {
      commandId: "verify-atomic-probe", type: "environment.verify",
      target: { kind: "environment_registration", id: registrationId },
      expected: { registration: 1 }, payload: {},
    });
    await context.hub.drain();
    const taskId = await createTask(context.hub, "atomic-existing-probe");
    const delegated = await context.hub.execute(member, {
      commandId: "delegate-atomic-probe", type: "attempt.delegate",
      target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1, registration: 2 },
      payload: { profileId: "profile-structured", environment: { mode: "existing",
        registrationId, expectedRegistrationRevision: 2, workAreas: [], requestedAccess: "read" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] },
    });
    const database = new DatabaseSync(context.path);
    database.exec(`CREATE TRIGGER fail_existing_successor BEFORE INSERT ON outbox
      WHEN NEW.work_type = 'execution.attachForDelegation'
      BEGIN SELECT RAISE(ABORT, 'simulated successor crash'); END`);
    database.close();

    // When
    await context.hub.drain({ limit: 1 });

    // Then
    assert.equal(context.hub.getEnvironmentRegistration(member, registrationId).revision, 2);
    assert.equal(context.hub.snapshot(member).operations?.some((operation) =>
      operation["operationKind"] === "execution.attachForDelegation"), false);
    const repair = new DatabaseSync(context.path);
    repair.exec("DROP TRIGGER fail_existing_successor");
    repair.close();
    now = new Date(now.getTime() + 1_000);
    for (let iteration = 0; iteration < 5; iteration += 1) await context.hub.drain();
    const attemptId = delegated.objectRefs[0]?.id;
    assert.ok(attemptId);
    assert.equal(context.hub.snapshot(member).attempts.find((attempt) => attempt.id === attemptId)?.phase,
      "running");
  } finally {
    context.close();
  }
});

test("the same local event id from different native sessions applies both effects", () => {
  // Given
  const context = fixture();
  try {
    const store = new Store(context.path);
    const state = new StateRepository(store.database, store.clock);
    let effects = 0;
    const event = (streamScope: string, nativeId: string) => ({ streamScope,
      nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated",
        kind: "agent-session", id: nativeId, incarnation: "v1" },
      bindingGeneration: 1, observedAt: "2026-10-25T00:00:00.000Z",
      payload: { type: "extension", namespace: "test", data: {} } });

    // When
    const first = state.claimInboundEvent({ workspaceId: "workspace-default",
      installationId: "runtime-sim-structured", sourceEventId: "event-1", bindingGeneration: 1,
      event: event("session-a", "native-a") }, () => { effects += 1; });
    const second = state.claimInboundEvent({ workspaceId: "workspace-default",
      installationId: "runtime-sim-structured", sourceEventId: "event-1", bindingGeneration: 1,
      event: event("session-b", "native-b") }, () => { effects += 1; });

    // Then
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(effects, 2);
    store.close();
  } finally {
    context.close();
  }
});
