import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Hub, type Actor } from "../application/orchestration/hub.ts";

const admin: Actor = {
  id: "user-admin", workspaceId: "workspace-default", role: "administrator",
  projectIds: ["project-default"], profileIds: ["profile-structured", "profile-limited"],
  bindingIds: [],
};
const member: Actor = {
  id: "user-member", workspaceId: "workspace-default", role: "member",
  projectIds: ["project-default"], profileIds: ["profile-structured", "profile-limited"],
  bindingIds: [],
};

async function hubFixture(runtimeProfile: "structured" | "limited_bridge" = "structured") {
  const directory = await mkdtemp(join(tmpdir(), "work-hub-orchestration-"));
  const path = join(directory, "hub.sqlite");
  return { hub: new Hub(path, { runtimeProfile }), path };
}

async function createTask(hub: Hub, commandId: string): Promise<string> {
  const receipt = await hub.execute(member, {
    commandId, type: "task.create",
    payload: { projectId: "project-default", title: `Task ${commandId}` },
  });
  const id = receipt.objectRefs[0]?.id;
  assert.ok(id);
  return id;
}

async function drainUntilIdle(hub: Hub): Promise<void> {
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const count = await hub.drain();
    if (count === 0) return;
  }
  assert.fail("Outbox did not become idle.");
}

test("delegation without an environment opens one session and sends one immutable input", async () => {
  // Given
  const { hub } = await hubFixture();
  const taskId = await createTask(hub, "cmd-task-delegate-none");

  // When
  const receipt = await hub.execute(member, {
    commandId: "cmd-delegate-none", type: "attempt.delegate",
    target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
    payload: {
      profileId: "profile-structured", environment: { mode: "none" },
      selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
    },
  });
  await drainUntilIdle(hub);

  // Then
  assert.equal(receipt.status, "accepted");
  const attemptId = receipt.objectRefs[0]?.id;
  assert.ok(attemptId);
  assert.equal(hub.snapshot(member).attempts.find((attempt) => attempt.id === attemptId)?.phase, "running");
  const simulator = hub.simulator;
  assert.ok(simulator);
  assert.deepEqual(
    simulator.calls.list().map((call) => call.operationKind),
    ["runtime.openSession", "runtime.startAttempt", "runtime.inspectSession"],
  );
  hub.close();
});

test("lost runtime receipt reconciles the original operation id without duplicate session creation", async () => {
  // Given
  const { hub } = await hubFixture();
  const simulator = hub.simulator;
  assert.ok(simulator);
  simulator.controls.scriptNext("runtime.openSession", { kind: "unknown_after_effect" });
  const taskId = await createTask(hub, "cmd-task-lost-receipt");

  // When
  await hub.execute(member, {
    commandId: "cmd-delegate-lost-receipt", type: "attempt.delegate",
    target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
    payload: {
      profileId: "profile-structured", environment: { mode: "none" },
      selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
    },
  });
  await drainUntilIdle(hub);

  // Then
  const calls = simulator.calls.list();
  assert.equal(calls.filter((call) => call.operationKind === "runtime.openSession").length, 1);
  assert.equal(calls.filter((call) => call.operationKind === "runtime.startAttempt").length, 1);
  assert.equal(calls.filter((call) => call.operationKind === "runtime.inspectSession").length, 1);
  hub.close();
});

test("existing environment verification is read-only and durable", async () => {
  // Given
  const { hub, path } = await hubFixture();
  const registered = await hub.execute(admin, {
    commandId: "cmd-register-existing", type: "environment.register",
    payload: {
      label: "existing-dev", executionInstallationId: "execution-sim",
      locator: { name: "existing-dev" }, allowedProjectIds: ["project-default"],
      allowedWorkAreas: [], allowRuntimeServiceLaunch: false,
    },
  });
  const registrationId = registered.objectRefs[0]?.id;
  assert.ok(registrationId);

  // When
  await hub.execute(admin, {
    commandId: "cmd-verify-existing", type: "environment.verify",
    target: { kind: "environment_registration", id: registrationId },
    expected: { registration: 1 }, payload: {},
  });
  await drainUntilIdle(hub);
  const simulator = hub.simulator;
  assert.ok(simulator);
  const calls = simulator.calls.list();
  hub.close();
  const restarted = new Hub(path);

  // Then
  assert.deepEqual(calls.map((call) => call.operationKind), ["execution.probeExisting"]);
  assert.equal(restarted.getEnvironmentRegistration(admin, registrationId).revision, 2);
  assert.ok(restarted.getEnvironmentRegistration(admin, registrationId).verifiedIdentity);
  restarted.close();
});

test("attaching an existing native session sends no greeting or initial work", async () => {
  // Given
  const { hub } = await hubFixture();
  const taskId = await createTask(hub, "cmd-task-attach-native");

  // When
  await hub.execute(member, {
    commandId: "cmd-attach-native", type: "session.attach",
    target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
    payload: {
      profileId: "profile-structured", controlMode: "observe",
      nativeSession: {
        installationId: "runtime-sim-structured", providerScope: "simulated",
        kind: "agent-session", id: "native-existing", incarnation: "v1",
      },
      environment: { mode: "none" },
    },
  });
  await drainUntilIdle(hub);

  // Then
  const simulator = hub.simulator;
  assert.ok(simulator);
  assert.deepEqual(
    simulator.calls.list().map((call) => call.operationKind),
    ["runtime.openSession", "runtime.inspectSession"],
  );
  assert.equal(
    simulator.calls.list().filter((call) => call.operationKind === "runtime.startAttempt").length,
    0,
  );
  hub.close();
});

test("limited runtime rejects unsupported immediate steering before connector invocation", async () => {
  // Given
  const { hub } = await hubFixture("limited_bridge");
  const taskId = await createTask(hub, "cmd-task-limited");
  const delegated = await hub.execute(member, {
    commandId: "cmd-delegate-limited", type: "attempt.delegate",
    target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
    payload: {
      profileId: "profile-limited", environment: { mode: "none" },
      selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
    },
  });
  await drainUntilIdle(hub);
  const attemptId = delegated.objectRefs[0]?.id;
  assert.ok(attemptId);
  const attempt = hub.snapshot(member).attempts.find((value) => value.id === attemptId);
  assert.ok(attempt);

  // When
  const receipt = await hub.execute(member, {
    commandId: "cmd-steer-limited", type: "session.instruct",
    target: { kind: "session", id: attempt.sessionId },
    expected: { bindingGeneration: 1 },
    payload: { attemptId, text: "Interrupt now", referenceIds: [], mode: "immediate" },
  });

  // Then
  assert.equal(receipt.error?.code, "instruction_timing_unsupported");
  const simulator = hub.simulator;
  assert.ok(simulator);
  assert.equal(simulator.calls.list().filter((call) => call.operationKind === "runtime.sendInstruction").length, 0);
  hub.close();
});
