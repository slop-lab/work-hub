import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from '../application/persistence/codec.ts';

import {
  admin, createTask, delegateNone, drainIdle, finishAttempt, fixture, member,
  operationKinds, provisionedArea,
} from "./acceptance-fixture.ts";

test("AT-21 a structured runtime question creates one canonical request in dashboard and session", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "21");
    const attempt = await delegateNone(context.hub, taskId, "21");
    const session = context.hub.getSession(member, attempt.sessionId).session;
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.emitQuestion({ hubSessionId: session.id, hubAttemptId: attempt.id, requestId: "native-question-21", projectId: "project-default", taskId, recipient: { kind: "user", userId: "user-admin" }, bindingGeneration: session.bindingGeneration, prompt: "Choose the compatibility target", responseRoute: "native", blocking: "runtime_action" });
    await context.hub.reconcile();
    const dashboard = context.hub.getDashboard(admin);
    const shell = context.hub.getSession(admin, session.id);
    assert.equal(dashboard.answerNeeded.length, 1);
    assert.equal(shell.requests.length, 1);
    assert.equal(dashboard.answerNeeded[0]?.id, shell.requests[0]?.id);
  } finally { context.close(); }
});

test("AT-23 a committed answer remains canonical when native delivery becomes unknown", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "23");
    const attempt = await delegateNone(context.hub, taskId, "23");
    const session = context.hub.getSession(member, attempt.sessionId).session;
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.emitQuestion({ hubSessionId: session.id, hubAttemptId: attempt.id, requestId: "native-question-23", projectId: "project-default", taskId, recipient: { kind: "user", userId: "user-admin" }, bindingGeneration: 1, prompt: "Proceed?", responseRoute: "native", blocking: "runtime_action" });
    await context.hub.reconcile();
    const request = context.hub.getDashboard(admin).answerNeeded[0];
    assert.ok(request);
    simulator.controls.scriptNext("runtime.deliverResponse", { kind: "unknown_after_effect" });
    const response = await context.hub.execute(admin, { commandId: "answer-23", type: "request.respond", target: { kind: "request", id: request.id }, expected: { request: request.revision, bindingGeneration: 1 }, payload: { answer: { kind: "text", text: "Proceed carefully" } } });
    assert.equal(response.confirmedEffect, "response.persisted");
    await context.hub.drain({ limit: 1 });
    assert.equal(context.hub.getRequest(admin, request.id).status, "answered");
    assert.equal(context.hub.getDashboard(admin).deliveryProblems.length, 1);
    assert.equal(context.hub.getDashboard(admin).answerNeeded.length, 0);
  } finally { context.close(); }
});

test("AT-25 an expired approval is rejected at response commit without runtime delivery", async () => {
  let now = new Date("2026-10-25T12:00:00.000Z");
  const context = fixture({ clock: { now: () => now } });
  try {
    const taskId = await createTask(context.hub, "25");
    const attempt = await delegateNone(context.hub, taskId, "25");
    const session = context.hub.getSession(admin, attempt.sessionId).session;
    const nativeSession = JSON.parse(session.nativeIdentityKey ?? "null");
    const startCall = context.hub.simulator?.calls.list().find((call) => call.operationKind === "runtime.startAttempt");
    const target = startCall?.input["target"];
    assert.ok(typeof target === "object" && target !== null);
    const controlGrantRef = Reflect.get(target, "controlGrantRef");
    assert.equal(typeof controlGrantRef, "string");
    const actionDescription = { effect: 'work.write', resource: 'simulated-protected-file' };
    const created = await context.hub.execute(admin, { commandId: "approval-25", type: "request.create", payload: { kind: "approval", projectId: "project-default", taskId, sessionId: session.id, attemptId: attempt.id, bindingGeneration: 1, recipient: { kind: "user", userId: "user-admin" }, prompt: "Allow protected write?", referenceIds: [], answerSchema: { kind: "approval", allowed: ["approve", "deny"] }, blocking: "runtime_action", responseRoute: "native", actionDescription,
      validity: { kind: "attempt", target: { hubSessionId: session.id, hubAttemptId: attempt.id, nativeSession, bindingGeneration: 1, controlGrantRef }, nativeRequestRef: { installationId: nativeSession.installationId, providerScope: nativeSession.providerScope, kind: "request", id: "approval-25" }, actionDigest: digest(actionDescription), policyRevision: String(attempt.profileRevision), environmentIdentities: [], expiresAt: "2026-10-25T12:01:00.000Z" } } });
    const requestId = created.objectRefs[0]?.id;
    assert.ok(requestId, JSON.stringify(created));
    now = new Date("2026-10-25T12:02:00.000Z");
    const response = await context.hub.execute(admin, { commandId: "expired-answer-25", type: "request.respond", target: { kind: "request", id: requestId }, expected: { request: 1, bindingGeneration: 1 }, payload: { answer: { kind: "approval", decision: "approve" } } });
    assert.equal(response.error?.code, "request_expired");
    assert.equal(operationKinds(context.hub).includes("runtime.deliverResponse"), false);
  } finally { context.close(); }
});

test("AT-26 a nonblocking question stays actionable without changing a running attempt to paused", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "26");
    const attempt = await delegateNone(context.hub, taskId, "26");
    await context.hub.execute(member, { commandId: "question-26", type: "request.create", payload: { kind: "question", projectId: "project-default", taskId, recipient: { kind: "project_members", projectId: "project-default" }, prompt: "Who reviews?", referenceIds: [], answerSchema: { kind: "text", minLength: 1, maxLength: 100 }, blocking: "none", validity: { kind: "task", taskId } } });
    assert.equal(context.hub.getDashboard(member).answerNeeded.length, 1);
    assert.equal(context.hub.snapshot(member).attempts.find((item) => item.id === attempt.id)?.phase, "running");
  } finally { context.close(); }
});

test("AT-27 asking an agent without a selected session cannot implicitly start work", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "27");
    const receipt = await context.hub.execute(member, { commandId: "question-27", type: "request.create", payload: { kind: "question", projectId: "project-default", taskId, sessionId: "not-selected", recipient: { kind: "agent_session", sessionId: "not-selected" }, prompt: "Can you investigate?", referenceIds: [], answerSchema: { kind: "text", minLength: 1, maxLength: 100 }, blocking: "none", validity: { kind: "task", taskId } } });
    assert.equal(receipt.error?.code, "request_context_mismatch");
    assert.equal(context.hub.snapshot(member).sessions.length, 0);
    assert.deepEqual(operationKinds(context.hub), []);
  } finally { context.close(); }
});

test("AT-28 unsupported mid-run timing is refused without connector invocation or silent queueing", async () => {
  const context = fixture({ runtimeProfile: "limited_bridge" });
  try {
    const taskId = await createTask(context.hub, "28");
    const delegated = await context.hub.execute(member, { commandId: "delegate-28", type: "attempt.delegate", target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: "profile-limited", environment: { mode: "none" }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] } });
    for (let iteration = 0; iteration < 6; iteration += 1) await context.hub.drain();
    const attemptId = delegated.objectRefs[0]?.id;
    const attempt = context.hub.snapshot(member).attempts.find((item) => item.id === attemptId);
    assert.ok(attempt);
    const before = operationKinds(context.hub).length;
    const receipt = await context.hub.execute(member, { commandId: "instruction-28", type: "session.instruct", target: { kind: "session", id: attempt.sessionId }, expected: { bindingGeneration: 1 }, payload: { attemptId: attempt.id, text: "Interrupt immediately", referenceIds: [], mode: "immediate" } });
    assert.equal(receipt.error?.code, "instruction_timing_unsupported");
    assert.equal(operationKinds(context.hub).length, before);
  } finally { context.close(); }
});

test("AT-29 continuation after termination creates a distinct attempt and immutable snapshot in the same session", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "29");
    const first = await delegateNone(context.hub, taskId, "29");
    await finishAttempt(context.hub, first);
    const session = context.hub.getSession(member, first.sessionId).session;
    const receipt = await context.hub.execute(member, { commandId: "continue-29", type: "session.continue", target: { kind: "session", id: session.id }, expected: { session: session.revision, task: context.hub.getTask(member, taskId).revision, profile: 1 }, payload: { profileId: "profile-structured", context: "current_task", environmentReuse: "reuse", instruction: "Continue with the review fixes" } });
    assert.equal(receipt.status, "accepted");
    await drainIdle(context.hub);
    const nextId = receipt.objectRefs[0]?.id;
    const next = context.hub.snapshot(member).attempts.find((item) => item.id === nextId);
    assert.ok(next);
    assert.notEqual(next.id, first.id);
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(next.inputSnapshot["instruction"], "Continue with the review fixes");
  } finally { context.close(); }
});

test("AT-30 a lost stop acknowledgment never creates a false terminal state", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "30");
    const attempt = await delegateNone(context.hub, taskId, "30");
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("runtime.requestStop", { kind: "unknown_after_effect" });
    await context.hub.execute(member, { commandId: "stop-30", type: "attempt.stop", target: { kind: "attempt", id: attempt.id }, expected: { bindingGeneration: 1 }, payload: { mode: "interrupt" } });
    await context.hub.drain({ limit: 1 });
    const current = context.hub.snapshot(member).attempts.find((item) => item.id === attempt.id);
    assert.equal(current?.unresolved, true);
    assert.equal(current?.outcome, undefined);
    assert.ok(current?.stopRequestedAt);
  } finally { context.close(); }
});

test("AT-31 lost allocation response is reconciled by the original operation ID without duplicate allocation", async () => {
  const context = fixture();
  try {
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("execution.requestAllocation", { kind: "unknown_after_effect" });
    const taskId = await createTask(context.hub, "31");
    await context.hub.execute(member, { commandId: "delegate-31", type: "attempt.delegate", target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: "profile-structured", environment: { mode: "provision", executionInstallationId: "execution-sim", externalProfileRef: "small", parameters: {}, releasePolicyRef: "retain", workAreas: [provisionedArea] }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] } });
    await drainIdle(context.hub);
    const calls = simulator.calls.list().filter((call) => call.operationKind === "execution.requestAllocation");
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.operationId);
    assert.equal(context.hub.snapshot(member).attempts[0]?.phase, "running");
  } finally { context.close(); }
});

test("AT-32 cancellation during provisioning fences late readiness and tracks cleanup separately", async () => {
  let now = new Date("2026-10-25T00:00:00.000Z");
  const context = fixture({ clock: { now: () => now } });
  try {
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("execution.requestAllocation", { kind: "accepted_waiting", progress: "late readiness" });
    const taskId = await createTask(context.hub, "32");
    const delegated = await context.hub.execute(member, { commandId: "delegate-32", type: "attempt.delegate", target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: "profile-structured", environment: { mode: "provision", executionInstallationId: "execution-sim", externalProfileRef: "small", parameters: {}, releasePolicyRef: "retain", workAreas: [provisionedArea] }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] } });
    await context.hub.drain({ limit: 1 });
    const attemptId = delegated.objectRefs[0]?.id;
    assert.ok(attemptId);
    const allocationCall = simulator.calls.list().find((call) => call.operationKind === "execution.requestAllocation");
    assert.ok(allocationCall?.operationId);
    assert.ok(allocationCall.inputDigest);
    simulator.controls.scriptNext("execution.cancelOperation", { kind: "accepted_waiting", progress: "cancellation pending allocation outcome" });
    await context.hub.execute(member, { commandId: "cancel-32", type: "attempt.stop", target: { kind: "attempt", id: attemptId }, expected: { bindingGeneration: 1 }, payload: { mode: "stop_work" } });
    await context.hub.drain();
    simulator.controls.completeAllocation(allocationCall.operationId);
    now = new Date(now.getTime() + 1_000);
    for (let iteration = 0; iteration < 3; iteration += 1) await context.hub.drain();

    const calls = simulator.calls.list();
    assert.deepEqual(calls.map((call) => call.operationKind), [
      "execution.requestAllocation",
      "execution.cancelOperation",
      "execution.releaseAllocation",
    ]);
    assert.deepEqual(calls.filter((call) => call.operationKind === "execution.requestAllocation").map((call) => ({ operationId: call.operationId, inputDigest: call.inputDigest })), [
      { operationId: allocationCall.operationId, inputDigest: allocationCall.inputDigest },
    ]);
    const releaseCall = calls[2];
    assert.ok(releaseCall);
    const allocationRef = releaseCall.input["allocationRef"];
    const expectedIdentity = releaseCall.input["expectedIdentity"];
    const lifecycleGrant = releaseCall.input["lifecycleGrant"];
    assert.ok(typeof allocationRef === "object" && allocationRef !== null);
    assert.ok(typeof expectedIdentity === "object" && expectedIdentity !== null);
    assert.ok(typeof lifecycleGrant === "object" && lifecycleGrant !== null);
    assert.equal(Reflect.get(allocationRef, "id"), `allocation:${attemptId}`);
    assert.equal(Reflect.get(Reflect.get(expectedIdentity, "native"), "id"), `allocation:${attemptId}`);
    assert.equal(Reflect.get(lifecycleGrant, "id"), `lifecycle:allocation:${attemptId}`);

    const snapshot = context.hub.snapshot(member);
    const attempt = snapshot.attempts.find((item) => item.id === attemptId);
    const binding = snapshot.environmentBindings.find((item) => item.attemptId === attemptId);
    assert.equal(calls.some((call) => call.operationKind === "runtime.startAttempt"), false);
    assert.ok(attempt?.stopRequestedAt);
    assert.equal(attempt.phase, "finished");
    assert.equal(attempt.outcome, "canceled");
    assert.ok(binding);
    assert.ok(binding.identity);
    assert.ok(binding.lifecycleGrant);
    const bindingNative = Reflect.get(binding.identity, "native");
    assert.ok(typeof bindingNative === "object" && bindingNative !== null);
    assert.equal(binding.sourceId, `allocation:${attemptId}`);
    assert.equal(Reflect.get(bindingNative, "id"), `allocation:${attemptId}`);
    assert.equal(Reflect.get(binding.lifecycleGrant, "id"), `lifecycle:allocation:${attemptId}`);
    assert.equal(binding.state, "released");
  } finally { context.close(); }
});
