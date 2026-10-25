import assert from "node:assert/strict";
import { test } from "node:test";

import { Hub } from "../application/orchestration/hub.ts";
import {
  admin, createTask, delegateExisting, delegateProvisioned, drainIdle, fixture,
  member, operationKinds, provisionedArea, registerReadyEnvironment, writableArea,
} from "./acceptance-fixture.ts";

test("AT-03 new-allocation delegation records one ordered allocation, attachment, session, and input sequence", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "03");
    const { attempt, binding } = await delegateProvisioned(context.hub, taskId, "03");
    assert.equal(attempt.phase, "running");
    assert.equal(attempt.inputSnapshot["taskRevision"], 1);
    assert.equal(binding.sourceKind, "allocation");
    assert.deepEqual(operationKinds(context.hub).filter((kind) => !kind.includes("inspect")), ["execution.requestAllocation", "execution.attach", "runtime.openSession", "runtime.startAttempt"]);
  } finally { context.close(); }
});

test("AT-05 concurrent distinct delegation commands cannot acquire two primary attempts", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "05");
    const command = (commandId: string) => context.hub.execute(member, {
      commandId, type: "attempt.delegate", target: { kind: "task", id: taskId },
      expected: { task: 1, profile: 1 },
      payload: { profileId: "profile-structured", environment: { mode: "none" }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] },
    });
    const receipts = await Promise.all([command("concurrent-a"), command("concurrent-b")]);
    assert.equal(receipts.filter((receipt) => receipt.status === "accepted").length, 1);
    assert.equal(receipts.filter((receipt) => receipt.status === "rejected").length, 1);
    assert.equal(context.hub.snapshot(member).attempts.filter((attempt) => attempt.role === "primary").length, 1);
  } finally { context.close(); }
});

test("AT-06 preparation remains durable when the client disappears and the Hub process restarts", async () => {
  const context = fixture();
  let restored: Hub | undefined;
  try {
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("execution.requestAllocation", { kind: "accepted_waiting", progress: "provider queue" });
    const taskId = await createTask(context.hub, "06");
    const receipt = await context.hub.execute(member, {
      commandId: "delegate-06", type: "attempt.delegate", target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
      payload: { profileId: "profile-structured", environment: { mode: "provision", executionInstallationId: "execution-sim", externalProfileRef: "small", parameters: {}, releasePolicyRef: "retain", workAreas: [provisionedArea] }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] },
    });
    await context.hub.drain({ limit: 1 });
    const attemptId = receipt.objectRefs[0]?.id;
    assert.ok(attemptId);
    context.hub.close();
    restored = new Hub(context.path);
    assert.equal(restored.snapshot(member).attempts.some((attempt) => attempt.id === attemptId && attempt.unresolved), true);
    await restored.drain({ limit: 1 });
    assert.equal(restored.snapshot(member).attempts.find((attempt) => attempt.id === attemptId)?.unresolved, true);
    assert.equal(operationKinds(restored).filter((kind) => kind === "execution.requestAllocation").length, 1);
  } finally { restored?.close(); if (restored === undefined) context.close(); }
});

test("AT-07 existing-target verification is read-only and persists resolved identity", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "07");
    const registration = context.hub.getEnvironmentRegistration(admin, registrationId);
    assert.equal(registration.verifiedIdentity?.["assurance"], "immutable");
    assert.deepEqual(operationKinds(context.hub), ["execution.probeExisting"]);
  } finally { context.close(); }
});

test("AT-08 ready existing-target delegation attaches and starts input without allocation", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "08");
    const taskId = await createTask(context.hub, "08");
    const receipt = await delegateExisting(context.hub, taskId, registrationId, "08");
    assert.equal(receipt.status, "accepted");
    const calls = operationKinds(context.hub);
    assert.equal(calls.includes("execution.requestAllocation"), false);
    assert.deepEqual(calls.filter((kind) => !kind.includes("inspect")), ["execution.probeExisting", "execution.probeExisting", "execution.attach", "runtime.openSession", "runtime.startAttempt"]);
  } finally { context.close(); }
});

test("AT-09 stopped existing target refuses delegation without start, install, or allocation fallback", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "09", { state: "stopped" });
    const taskId = await createTask(context.hub, "09");
    const registration = context.hub.getEnvironmentRegistration(admin, registrationId);
    const receipt = await context.hub.execute(member, {
      commandId: "delegate-stopped", type: "attempt.delegate", target: { kind: "task", id: taskId },
      expected: { task: 1, profile: 1, registration: registration.revision },
      payload: { profileId: "profile-structured", environment: { mode: "existing", registrationId, expectedRegistrationRevision: registration.revision, workAreas: [writableArea], requestedAccess: "write" }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] },
    });
    assert.equal(receipt.error?.code, "environment_not_ready");
    assert.deepEqual(operationKinds(context.hub), ["execution.probeExisting"]);
  } finally { context.close(); }
});

test("AT-10 failed native-session creation in an existing target detaches only attachment-owned access", async () => {
  const context = fixture();
  try {
    const registrationId = await registerReadyEnvironment(context.hub, "10");
    const taskId = await createTask(context.hub, "10");
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("runtime.openSession", { kind: "definite_failure", code: "native_open_failed" });
    await delegateExisting(context.hub, taskId, registrationId, "10");
    const calls = operationKinds(context.hub);
    assert.equal(calls.includes("execution.detachAttachment"), true);
    assert.equal(calls.includes("execution.releaseAllocation"), false);
  } finally { context.close(); }
});
