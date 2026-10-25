import assert from "node:assert/strict";
import { test } from "node:test";

import {
  admin,
  createTask,
  delegateNone,
  drainIdle,
  finishAttempt,
  fixture,
  member,
} from "./acceptance-fixture.ts";

test("definite attempt input failure ends work without closing the reusable session", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "input-failure");
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("runtime.startAttempt", { kind: "definite_failure" });

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "delegate-input-failure",
      type: "attempt.delegate",
      target: { kind: "task", id: taskId },
      expected: { task: 1, profile: 1 },
      payload: {
        profileId: "profile-structured",
        environment: { mode: "none" },
        selectedReferenceIds: [],
        selectedResponseIds: [],
        authorizedEffectKinds: [],
      },
    });
    await drainIdle(context.hub);

    // Then
    const attemptId = receipt.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(attemptId);
    const attempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attemptId);
    assert.ok(attempt);
    const session = context.hub.getSession(member, attempt.sessionId).session;
    assert.equal(attempt.outcome, "failed");
    assert.equal(session.lifecycle, "open");
    assert.equal(session.activeAttemptId, attempt.id);
  } finally {
    context.close();
  }
});

test("definite session open failure ends the attempt and closes the unopened session", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "open-failure");
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("runtime.openSession", { kind: "definite_failure" });

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "delegate-open-failure",
      type: "attempt.delegate",
      target: { kind: "task", id: taskId },
      expected: { task: 1, profile: 1 },
      payload: {
        profileId: "profile-structured",
        environment: { mode: "none" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
      },
    });
    await drainIdle(context.hub);

    // Then
    const attemptId = receipt.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(attemptId);
    const attempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attemptId);
    assert.ok(attempt);
    assert.equal(attempt.outcome, "failed");
    assert.equal(context.hub.getSession(member, attempt.sessionId).session.lifecycle, "closed");
  } finally {
    context.close();
  }
});

test("definite response delivery failure becomes a rejected delivery problem", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "delivery-failure");
    const attempt = await delegateNone(context.hub, taskId, "delivery-failure");
    const session = context.hub.getSession(member, attempt.sessionId).session;
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.emitQuestion({
      hubSessionId: session.id,
      hubAttemptId: attempt.id,
      requestId: "delivery-failure-question",
      projectId: "project-default",
      taskId,
      recipient: { kind: "user", userId: admin.id },
      bindingGeneration: session.bindingGeneration,
      prompt: "Proceed?",
      responseRoute: "native",
      blocking: "runtime_action",
    });
    await context.hub.reconcile();
    const request = context.hub.getDashboard(admin).answerNeeded[0];
    assert.ok(request);
    simulator.controls.scriptNext("runtime.deliverResponse", { kind: "definite_failure" });

    // When
    await context.hub.execute(admin, {
      commandId: "answer-delivery-failure",
      type: "request.respond",
      target: { kind: "request", id: request.id },
      expected: { request: request.revision, bindingGeneration: session.bindingGeneration },
      payload: { answer: { kind: "text", text: "Proceed" } },
    });
    await drainIdle(context.hub);

    // Then
    const problem = context.hub.getDashboard(admin).deliveryProblems[0];
    assert.ok(problem);
    assert.equal(problem["status"], "rejected");
  } finally {
    context.close();
  }
});

test("ended attempts cannot be revived or receive new instructions", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "terminal-monotonic");
    const attempt = await delegateNone(context.hub, taskId, "terminal-monotonic");
    await finishAttempt(context.hub, attempt);
    const session = context.hub.getSession(member, attempt.sessionId).session;
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.seedSession({
      hubSessionId: session.id,
      nativeSession: JSON.parse(session.nativeIdentityKey ?? "null"),
      controlMode: "control",
      phase: "running",
      hubAttemptId: attempt.id,
    });

    // When
    await context.hub.reconcile();
    const receipt = await context.hub.execute(member, {
      commandId: "instruct-ended-attempt",
      type: "session.instruct",
      target: { kind: "session", id: session.id },
      expected: { bindingGeneration: session.bindingGeneration },
      payload: { attemptId: attempt.id, text: "Do not revive", referenceIds: [], mode: "immediate" },
    });

    // Then
    assert.equal(context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attempt.id)?.phase, "finished");
    assert.equal(receipt.error?.code, "attempt_target_conflict");
    assert.equal(simulator.calls.list().filter((call) => call.operationKind === "runtime.sendInstruction").length, 0);
  } finally {
    context.close();
  }
});

test("later runtime control targets reuse the native execution reference returned at start", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "native-execution-target");
    const attempt = await delegateNone(context.hub, taskId, "native-execution-target");
    const session = context.hub.getSession(member, attempt.sessionId).session;

    // When
    await context.hub.execute(member, {
      commandId: "instruction-native-execution-target",
      type: "session.instruct",
      target: { kind: "session", id: session.id },
      expected: { bindingGeneration: session.bindingGeneration },
      payload: { attemptId: attempt.id, text: "Continue", referenceIds: [], mode: "immediate" },
    });
    await drainIdle(context.hub);

    // Then
    const call = context.hub.simulator?.calls.list()
      .find((candidate) => candidate.operationKind === "runtime.sendInstruction");
    const target = call?.input["target"];
    assert.ok(typeof target === "object" && target !== null);
    const nativeExecutionRef = Reflect.get(target, "nativeExecutionRef");
    assert.ok(typeof nativeExecutionRef === "object" && nativeExecutionRef !== null);
    assert.equal(Reflect.get(nativeExecutionRef, "id"), `execution:${attempt.id}`);
  } finally {
    context.close();
  }
});

test("session close durably detaches the runtime before becoming closed", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "session-close");
    const attempt = await delegateNone(context.hub, taskId, "session-close");
    await finishAttempt(context.hub, attempt);
    const session = context.hub.getSession(member, attempt.sessionId).session;

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "close-runtime-session",
      type: "session.close",
      target: { kind: "session", id: session.id },
      expected: { session: session.revision },
      payload: {},
    });
    await drainIdle(context.hub);

    // Then
    assert.equal(receipt.status, "accepted");
    assert.equal(context.hub.getSession(member, session.id).session.lifecycle, "closed");
    assert.equal(context.hub.simulator?.calls.list().filter((call) => call.operationKind === "runtime.detachSession").length, 1);
  } finally {
    context.close();
  }
});

test("cancellation after runtime open detaches the unused session", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "cancel-after-open");
    const delegated = await context.hub.execute(member, {
      commandId: "delegate-cancel-after-open",
      type: "attempt.delegate",
      target: { kind: "task", id: taskId },
      expected: { task: 1, profile: 1 },
      payload: {
        profileId: "profile-structured",
        environment: { mode: "none" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
      },
    });
    await context.hub.drain({ limit: 1 });
    const attemptId = delegated.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(attemptId);
    const attempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attemptId);
    assert.ok(attempt);
    const session = context.hub.getSession(member, attempt.sessionId).session;

    // When
    await context.hub.execute(member, {
      commandId: "stop-cancel-after-open",
      type: "attempt.stop",
      target: { kind: "attempt", id: attempt.id },
      expected: { bindingGeneration: session.bindingGeneration },
      payload: { mode: "stop_work", reason: "Cancel before input" },
    });
    await drainIdle(context.hub);

    // Then
    assert.equal(context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attempt.id)?.outcome, "canceled");
    assert.equal(context.hub.getSession(member, session.id).session.lifecycle, "closed");
    assert.equal(context.hub.simulator?.calls.list().filter((call) => call.operationKind === "runtime.detachSession").length, 1);
  } finally {
    context.close();
  }
});
