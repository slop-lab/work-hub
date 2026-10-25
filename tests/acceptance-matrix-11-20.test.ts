import assert from "node:assert/strict";
import { test } from "node:test";

import {
  admin, createTask, delegateExisting, delegateNone, delegateProvisioned, drainIdle,
  finishAttempt, fixture, member, operationKinds, registerReadyEnvironment,
} from "./acceptance-fixture.ts";

test("AT-11 detaching an existing binding ends access without release or environment lifecycle calls", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "11");
    const taskId = await createTask(context.hub, "11");
    await delegateExisting(context.hub, taskId, registrationId, "11");
    const attempt = context.hub.snapshot(member).attempts[0];
    const binding = context.hub.snapshot(member).environmentBindings[0];
    assert.ok(attempt); assert.ok(binding);
    await finishAttempt(context.hub, attempt);
    const receipt = await context.hub.execute(admin, { commandId: "detach-11", type: "environment.detach", target: { kind: "environment_binding", id: binding.id }, expected: { bindingGeneration: binding.generation }, payload: { reason: "finished" } });
    assert.equal(receipt.status, "accepted");
    await drainIdle(context.hub);
    assert.equal(context.hub.getEnvironmentBinding(admin, binding.id).state, "detached");
    assert.equal(operationKinds(context.hub).filter((kind) => kind === "execution.detachAttachment").length, 1);
    assert.equal(operationKinds(context.hub).includes("execution.releaseAllocation"), false);
  } finally { context.close(); }
});

test("AT-12 attach-only release is rejected before provider invocation", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "12");
    const taskId = await createTask(context.hub, "12");
    await delegateExisting(context.hub, taskId, registrationId, "12");
    const binding = context.hub.snapshot(admin).environmentBindings[0];
    assert.ok(binding);
    const before = operationKinds(context.hub).length;
    const receipt = await context.hub.execute(admin, { commandId: "release-attach-only", type: "environment.release", target: { kind: "environment_binding", id: binding.id }, expected: { bindingGeneration: binding.generation }, payload: { preservationDecisionRef: "preserve" } });
    assert.equal(receipt.error?.code, "forbidden");
    assert.equal(operationKinds(context.hub).length, before);
  } finally { context.close(); }
});

test("AT-13 managed release preserves the provider's exact retention disposition", async () => {
  for (const disposition of ["retained", "stopped", "deleted"] as const) {
    const context = fixture();
    try {
      const taskId = await createTask(context.hub, `13-${disposition}`);
      const { attempt, binding } = await delegateProvisioned(context.hub, taskId, `13-${disposition}`);
      await finishAttempt(context.hub, attempt);
      const native = binding.lifecycleGrant?.["allocationRef"];
      assert.ok(typeof native === "object" && native !== null);
      const allocationId = Reflect.get(native, "id");
      assert.equal(typeof allocationId, "string");
      const simulator = context.hub.simulator;
      assert.ok(simulator);
      simulator.controls.setReleaseResult(allocationId, { disposition, referenceAvailability: disposition === "deleted" ? "may_expire" : "preserved" });
      const release = await context.hub.execute(admin, { commandId: `release-${disposition}`, type: "environment.release", target: { kind: "environment_binding", id: binding.id }, expected: { bindingGeneration: binding.generation }, payload: { preservationDecisionRef: disposition === 'deleted' ? 'accept_reference_expiry' : 'preserve_references' } });
      assert.equal(release.status, "accepted", JSON.stringify(release));
      await drainIdle(context.hub);
      const operation = context.hub.snapshot(admin).operations?.find((item) => item["commandId"] === `release-${disposition}`);
      const receiptJson = operation?.["receiptJson"];
      assert.equal(typeof receiptJson, "string");
      if (typeof receiptJson !== "string") assert.fail("Release operation receipt is missing.");
      assert.equal(JSON.parse(receiptJson)["result"]["disposition"], disposition);
    } finally { context.close(); }
  }
});

test("AT-14 incarnation replacement blocks a pending mutation instead of attaching the reused locator", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "14");
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.setEnvironment(registrationId, { state: "running", assurance: "immutable", externalActivity: "idle", incarnation: "incarnation-2" });
    const taskId = await createTask(context.hub, "14");
    await delegateExisting(context.hub, taskId, registrationId, "14");
    assert.equal(operationKinds(context.hub).includes("execution.attach"), false);
    assert.equal(context.hub.snapshot(member).dashboard.operationalIssues.some((item) => item["status"] === "failed" || item["status"] === "unknown"), true);
  } finally { context.close(); }
});

test("AT-15 weak identity is disclosed and cannot be used for mutation without explicit acceptance", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "15", { assurance: "weak" });
    const registration = context.hub.getEnvironmentRegistration(admin, registrationId);
    assert.equal(registration.verifiedIdentity?.["assurance"], "weak");
    const taskId = await createTask(context.hub, "15");
    const receipt = await context.hub.execute(member, { commandId: "delegate-weak-15", type: "attempt.delegate", target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1, registration: registration.revision }, payload: { profileId: "profile-structured", environment: { mode: "existing", registrationId, expectedRegistrationRevision: registration.revision, workAreas: [], requestedAccess: "read" }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] } });
    assert.equal(receipt.error?.code, "weak_identity_confirmation_required");
    assert.equal(operationKinds(context.hub).includes("execution.attach"), false);
  } finally { context.close(); }
});

test("AT-16 a hub reservation blocks a second writer targeting the same work area", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "16");
    const firstTask = await createTask(context.hub, "16-first");
    await delegateExisting(context.hub, firstTask, registrationId, "16-first");
    const secondTask = await createTask(context.hub, "16-second");
    const second = await delegateExisting(context.hub, secondTask, registrationId, "16-second");
    assert.equal(second.error?.code, "concurrency_conflict");
    assert.equal(context.hub.snapshot(member).attempts.filter((attempt) => attempt.unresolved).length, 1);
  } finally { context.close(); }
});

test("AT-17 attaching an idle native session sends no initial instruction, greeting, resume, or create request", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "17");
    const receipt = await context.hub.execute(member, { commandId: "attach-17", type: "session.attach", target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: "profile-structured", controlMode: "observe", nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated", kind: "agent-session", id: "idle-17", incarnation: "v1" }, environment: { mode: "none" } } });
    assert.equal(receipt.status, "accepted");
    await drainIdle(context.hub);
    const calls = context.hub.simulator?.calls.list() ?? [];
    assert.deepEqual(calls.map((call) => call.operationKind), ["runtime.openSession", "runtime.inspectSession"]);
    assert.equal(Reflect.get(calls[0]?.input ?? {}, "mode"), "attach");
  } finally { context.close(); }
});

test("AT-18 attaching active external work creates an observed attempt with unknown original input", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "18");
    const receipt = await context.hub.execute(member, { commandId: "attach-18", type: "session.attach", target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: "profile-structured", controlMode: "observe", nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated", kind: "agent-session", id: "active-18", incarnation: "v1" }, environment: { mode: "none" } } });
    const sessionId = receipt.objectRefs[0]?.id;
    assert.ok(sessionId);
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.seedSession({ hubSessionId: sessionId, nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated", kind: "agent-session", id: "active-18", incarnation: "v1" }, controlMode: "observe", phase: "running" });
    await drainIdle(context.hub);
    const attempt = context.hub.snapshot(member).attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.role, "observed");
    assert.equal(attempt.origin, "attached_existing");
    assert.equal(attempt.inputSnapshot["instruction"], undefined);
  } finally { context.close(); }
});

test("AT-19 view-only attachment refuses both instruction and stop before runtime invocation", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "19");
    const receipt = await context.hub.execute(member, { commandId: "attach-19", type: "session.attach", target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: "profile-structured", controlMode: "observe", nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated", kind: "agent-session", id: "active-19", incarnation: "v1" }, environment: { mode: "none" } } });
    const sessionId = receipt.objectRefs[0]?.id;
    assert.ok(sessionId);
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.seedSession({ hubSessionId: sessionId, nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated", kind: "agent-session", id: "active-19", incarnation: "v1" }, controlMode: "observe", phase: "running" });
    await drainIdle(context.hub);
    const attempt = context.hub.snapshot(member).attempts[0];
    assert.ok(attempt);
    const instruction = await context.hub.execute(member, { commandId: "observe-instruct", type: "session.instruct", target: { kind: "session", id: sessionId }, expected: { bindingGeneration: 1 }, payload: { attemptId: attempt.id, text: "mutate", referenceIds: [], mode: "immediate" } });
    const stop = await context.hub.execute(member, { commandId: "observe-stop", type: "attempt.stop", target: { kind: "attempt", id: attempt.id }, expected: { bindingGeneration: 1 }, payload: { mode: "stop_work" } });
    assert.equal(instruction.error?.code, "forbidden");
    assert.equal(stop.error?.code, "forbidden");
    assert.equal(operationKinds(context.hub).some((kind) => kind === "runtime.sendInstruction" || kind === "runtime.requestStop"), false);
  } finally { context.close(); }
});

test("AT-20 multiple session views reuse one native identity and never launch another process", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "20");
    const attempt = await delegateNone(context.hub, taskId, "20");
    const before = operationKinds(context.hub).length;
    const first = context.hub.getSession(member, attempt.sessionId);
    const second = context.hub.getSession(member, attempt.sessionId);
    assert.equal(first.session.nativeIdentityKey, second.session.nativeIdentityKey);
    assert.equal(operationKinds(context.hub).length, before);
    assert.equal(first.availableCommandTypes.includes("interactive_input"), false);
  } finally { context.close(); }
});
