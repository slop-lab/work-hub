import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Hub } from "../application/orchestration/hub.ts";
import { createSimulators } from "../application/simulator/index.ts";
import { admin, createTask, delegateExisting, delegateProvisioned, drainIdle, finishAttempt,
  fixture, member, registerReadyEnvironment } from "./acceptance-fixture.ts";

async function delegateProvision(hub: Hub, taskId: string, suffix: string) {
  return hub.execute(member, {
    commandId: `delegate-failure-${suffix}`, type: "attempt.delegate",
    target: { kind: "task", id: taskId },
    expected: { task: hub.getTask(member, taskId).revision, profile: 1 },
    payload: { profileId: "profile-structured", environment: { mode: "provision",
      executionInstallationId: "execution-sim", externalProfileRef: "small", parameters: {},
      releasePolicyRef: "retain", workAreas: [] }, selectedReferenceIds: [],
      selectedResponseIds: [], authorizedEffectKinds: [] },
  });
}

test("definite allocation failure finishes the attempt and fails its unallocated binding", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "allocation-failure");
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("execution.requestAllocation", { kind: "definite_failure" });
    const receipt = await delegateProvision(context.hub, taskId, "allocation");
    await drainIdle(context.hub);
    const attemptId = receipt.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(attemptId);
    const snapshot = context.hub.snapshot(member);
    assert.equal(snapshot.attempts.find((candidate) => candidate.id === attemptId)?.outcome, "failed");
    assert.equal(snapshot.environmentBindings.find((candidate) => candidate.attemptId === attemptId)?.state, "failed");
  } finally { context.close(); }
});

test("definite environment attachment failure finishes the attempt and fails its binding", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "attach-failure");
    const taskId = await createTask(context.hub, "attach-failure");
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("execution.attach", { kind: "definite_failure" });
    const receipt = await delegateExisting(context.hub, taskId, registrationId, "attach-failure");
    const attemptId = receipt.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(attemptId);
    const snapshot = context.hub.snapshot(member);
    assert.equal(snapshot.attempts.find((candidate) => candidate.id === attemptId)?.outcome, "failed");
    assert.equal(snapshot.environmentBindings.find((candidate) => candidate.attemptId === attemptId)?.state, "failed");
  } finally { context.close(); }
});

async function attachSessionEnvironment(
  outcome: "definite_failure" | "unknown_after_effect",
  suffix: string,
) {
  const context = fixture();
  const registrationId = await registerReadyEnvironment(context.hub, suffix);
  const registration = context.hub.getEnvironmentRegistration(admin, registrationId);
  const taskId = await createTask(context.hub, suffix);
  const simulator = context.hub.simulator;
  assert.ok(simulator);
  simulator.controls.scriptNext("execution.attach", { kind: outcome });
  const receipt = await context.hub.execute(member, {
    commandId: `attach-${suffix}`, type: "session.attach", target: { kind: "task", id: taskId },
    expected: { task: 1, profile: 1, registration: registration.revision },
    payload: { profileId: "profile-structured", controlMode: "control",
      nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated",
        kind: "agent-session", id: suffix, incarnation: "v1" },
      environment: { mode: "existing", registrationId,
        expectedRegistrationRevision: registration.revision, workAreas: [], requestedAccess: "read" } },
  });
  await drainIdle(context.hub);
  const sessionId = receipt.objectRefs.find((reference) => reference.kind === "session")?.id;
  assert.ok(sessionId);
  return { context, sessionId };
}

test("definite session environment attachment failure closes the opening session", async () => {
  const { context, sessionId } = await attachSessionEnvironment(
    "definite_failure", "session-attach-failure",
  );
  try {
    assert.equal(context.hub.getSession(member, sessionId).session.lifecycle, "closed");
    assert.equal(context.hub.snapshot(member).environmentBindings
      .find((binding) => binding.sessionId === sessionId)?.state, "failed");
  } finally { context.close(); }
});

test("lost session environment attachment receipt applies lookup and opens the session", async () => {
  const { context, sessionId } = await attachSessionEnvironment(
    "unknown_after_effect", "session-attach-lookup",
  );
  try {
    assert.equal(context.hub.getSession(member, sessionId).session.lifecycle, "open");
    assert.equal(context.hub.snapshot(member).environmentBindings
      .find((binding) => binding.sessionId === sessionId)?.state, "attached");
  } finally { context.close(); }
});

test("definite detach and release failures leave bindings failed rather than in progress", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "detach-definite");
    const taskId = await createTask(context.hub, "detach-definite");
    await delegateExisting(context.hub, taskId, registrationId, "detach-definite");
    const existingAttempt = context.hub.snapshot(member).attempts[0];
    const existingBinding = context.hub.snapshot(member).environmentBindings[0];
    assert.ok(existingAttempt); assert.ok(existingBinding);
    await finishAttempt(context.hub, existingAttempt);
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("execution.detachAttachment", { kind: "definite_failure" });
    await context.hub.execute(admin, { commandId: "detach-definite-failure",
      type: "environment.detach", target: { kind: "environment_binding", id: existingBinding.id },
      expected: { bindingGeneration: existingBinding.generation }, payload: { reason: "finished" } });
    await drainIdle(context.hub);
    assert.equal(context.hub.getEnvironmentBinding(admin, existingBinding.id).state, "failed");

    const managedTaskId = await createTask(context.hub, "release-definite");
    const managed = await delegateProvisioned(context.hub, managedTaskId, "release-definite");
    await finishAttempt(context.hub, managed.attempt);
    simulator.controls.scriptNext("execution.releaseAllocation", { kind: "definite_failure" });
    await context.hub.execute(admin, { commandId: "release-definite-failure",
      type: "environment.release", target: { kind: "environment_binding", id: managed.binding.id },
      expected: { bindingGeneration: managed.binding.generation },
      payload: { preservationDecisionRef: "preserve_references" } });
    await drainIdle(context.hub);
    assert.equal(context.hub.getEnvironmentBinding(admin, managed.binding.id).state, "failed");
  } finally { context.close(); }
});

test("probe exception retries the original attachment stage without operation lookup", async () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "work-hub-probe-retry-"));
  const path = join(root, "hub.sqlite");
  const simulators = createSimulators(path);
  let now = new Date("2026-10-25T12:00:00.000Z");
  const hub = new Hub(path, { mode: "external", clock: { now: () => now }, connectors: {
    execution: { "execution-sim": simulators.execution },
    runtime: {
      "runtime-sim-structured": simulators.runtimeFor("structured"),
      "runtime-sim-limited": simulators.runtimeFor("limited_bridge"),
    },
  } });
  try {
    const registered = await hub.execute(admin, { commandId: "register-probe-retry",
      type: "environment.register", payload: { label: "Probe retry",
        executionInstallationId: "execution-sim", locator: { name: "probe-retry" },
        allowedProjectIds: ["project-default"], allowedWorkAreas: [],
        allowRuntimeServiceLaunch: false } });
    const registrationId = registered.objectRefs[0]?.id;
    assert.ok(registrationId);
    simulators.controls.setEnvironment(registrationId, { state: "running", assurance: "immutable",
      externalActivity: "idle", incarnation: "v1" });
    await hub.execute(admin, { commandId: "verify-probe-retry", type: "environment.verify",
      target: { kind: "environment_registration", id: registrationId },
      expected: { registration: 1 }, payload: {} });
    await drainIdle(hub);
    const originalProbe = simulators.execution.probeExisting.bind(simulators.execution);
    let failProbe = true;
    simulators.execution.probeExisting = async (context, registration) => {
      if (failProbe) {
        failProbe = false;
        throw new Error("transient probe failure");
      }
      return originalProbe(context, registration);
    };
    const taskId = await createTask(hub, "probe-retry");
    const registration = hub.getEnvironmentRegistration(admin, registrationId);
    await hub.execute(member, { commandId: "delegate-probe-retry", type: "attempt.delegate",
      target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1,
        registration: registration.revision }, payload: { profileId: "profile-structured",
        environment: { mode: "existing", registrationId,
          expectedRegistrationRevision: registration.revision, workAreas: [], requestedAccess: "read" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] } });

    // When
    await hub.drain({ limit: 1 });

    // Then
    assert.equal((hub.snapshot(member).operations ?? []).some((operation) =>
      operation["operationKind"] === "operation.lookup"), false);
    assert.equal((hub.snapshot(member).operations ?? []).some((operation) =>
      operation["operationKind"] === "delegation.advance" && operation["status"] === "accepted"), true);
    now = new Date("2026-10-25T12:10:00.000Z");
    await drainIdle(hub);
    assert.equal(hub.snapshot(member).attempts.some((attempt) => attempt.phase === "running"), true);
  } finally {
    hub.close();
    simulators.close();
    rmSync(root, { recursive: true });
  }
});
