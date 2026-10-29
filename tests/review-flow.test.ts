import assert from "node:assert/strict";
import { test } from "node:test";

import type { AttemptView, ResultView } from "../application/domain/model.ts";
import type { Hub } from "../application/orchestration/hub.ts";
import { PromptEnvelopeSchema } from "../application/prompts/index.ts";
import {
  admin,
  createTask,
  delegateNone,
  drainIdle,
  finishAttempt,
  fixture,
  member,
} from "./acceptance-fixture.ts";

async function reportResult(hub: Hub, attempt: AttemptView, summary: string): Promise<ResultView> {
  const simulator = hub.simulator;
  assert.ok(simulator);
  const session = hub.getSession(member, attempt.sessionId).session;
  simulator.controls.emitResult({
    hubSessionId: session.id,
    hubAttemptId: attempt.id,
    bindingGeneration: session.bindingGeneration,
    summary,
    referenceIds: [],
  });
  await hub.reconcile();
  const result = hub.snapshot(member).results.find((candidate) => candidate.attemptId === attempt.id);
  assert.ok(result);
  return result;
}

test("revision instruction dispatches once to the exact active result attempt", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "review-active");
    const attempt = await delegateNone(context.hub, taskId, "review-active");
    const result = await reportResult(context.hub, attempt, "Active result");
    const session = context.hub.getSession(member, attempt.sessionId).session;

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "revision-active",
      type: "task.requestRevision",
      target: { kind: "task", id: taskId },
      expected: { task: context.hub.getTask(member, taskId).revision, bindingGeneration: session.bindingGeneration },
      payload: {
        resultId: result.id,
        sessionId: session.id,
        instruction: "Address the review findings",
        path: "instruction",
      },
    });
    await drainIdle(context.hub);

    // Then
    assert.equal(receipt.status, "accepted");
    const calls = context.hub.simulator?.calls.list()
      .filter((call) => call.operationKind === "runtime.sendInstruction") ?? [];
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input["text"], "Address the review findings");
    assert.equal(calls[0]?.input["mode"], "immediate");
    const target = calls[0]?.input["target"];
    assert.ok(typeof target === "object" && target !== null);
    assert.equal(Reflect.get(target, "hubAttemptId"), attempt.id);
  } finally {
    context.close();
  }
});

test("revision continuation starts one new attempt with result provenance in the same session", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "review-ended");
    const first = await delegateNone(context.hub, taskId, "review-ended");
    const result = await reportResult(context.hub, first, "Retain this result summary");
    await finishAttempt(context.hub, first);
    const session = context.hub.getSession(member, first.sessionId).session;

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "revision-ended",
      type: "task.requestRevision",
      target: { kind: "task", id: taskId },
      expected: { task: context.hub.getTask(member, taskId).revision, session: session.revision, profile: 1 },
      payload: {
        resultId: result.id,
        sessionId: session.id,
        instruction: "Continue from the reviewed result",
        path: "continuation",
        profileId: "profile-structured",
        context: "current_task",
        environmentReuse: "reuse",
      },
    });
    await drainIdle(context.hub);

    // Then
    assert.equal(receipt.status, "accepted");
    const attemptId = receipt.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(attemptId);
    const next = context.hub.snapshot(member).attempts.find((attempt) => attempt.id === attemptId);
    assert.ok(next);
    assert.notEqual(next.id, first.id);
    assert.equal(next.sessionId, first.sessionId);
    const instruction = next.inputSnapshot["instruction"];
    if (typeof instruction !== "string") throw new TypeError("Continuation prompt missing");
    const prompt = PromptEnvelopeSchema.parse(JSON.parse(instruction));
    assert.equal(prompt.template.id, "task_brief");
    assert.equal(prompt.input["attemptId"], next.id);
    assert.equal(prompt.input["instruction"], "Continue from the reviewed result");
    const contextItems = next.inputSnapshot["contextItems"];
    assert.ok(Array.isArray(contextItems));
    const source = contextItems.find((item) => typeof item === "object" && item !== null && Reflect.get(item, "sourceId") === result.id);
    assert.ok(source);
    assert.match(String(Reflect.get(source, "includedText")), /Retain this result summary/);
    const starts = context.hub.simulator?.calls.list()
      .filter((call) => call.operationKind === "runtime.startAttempt") ?? [];
    assert.equal(starts.length, 2);
  } finally {
    context.close();
  }
});

test("revision rejects a result from another task without runtime input", async () => {
  // Given
  const context = fixture();
  try {
    const sourceTaskId = await createTask(context.hub, "review-source");
    const sourceAttempt = await delegateNone(context.hub, sourceTaskId, "review-source");
    const result = await reportResult(context.hub, sourceAttempt, "Wrong task result");
    const targetTaskId = await createTask(context.hub, "review-target");

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "revision-wrong-task",
      type: "task.requestRevision",
      target: { kind: "task", id: targetTaskId },
      expected: { task: context.hub.getTask(member, targetTaskId).revision, bindingGeneration: 1 },
      payload: {
        resultId: result.id,
        sessionId: sourceAttempt.sessionId,
        instruction: "Do not retarget this result",
        path: "instruction",
      },
    });

    // Then
    assert.equal(receipt.error?.code, "revision_target_conflict");
    assert.equal(context.hub.simulator?.calls.list()
      .filter((call) => call.operationKind === "runtime.sendInstruction").length, 0);
  } finally {
    context.close();
  }
});

test("revision refuses unsupported immediate input without silently queueing", async () => {
  // Given
  const context = fixture({ runtimeProfile: "limited_bridge" });
  try {
    const taskId = await createTask(context.hub, "review-mode");
    const delegated = await context.hub.execute(member, {
      commandId: "delegate-review-mode",
      type: "attempt.delegate",
      target: { kind: "task", id: taskId },
      expected: { task: 1, profile: 1 },
      payload: {
        profileId: "profile-limited",
        environment: { mode: "none" },
        selectedReferenceIds: [],
        selectedResponseIds: [],
        authorizedEffectKinds: [],
      },
    });
    await drainIdle(context.hub);
    const attemptId = delegated.objectRefs[0]?.id;
    const attempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attemptId);
    assert.ok(attempt);
    const result = await reportResult(context.hub, attempt, "Limited result");

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "revision-unsupported-mode",
      type: "task.requestRevision",
      target: { kind: "task", id: taskId },
      expected: { task: context.hub.getTask(member, taskId).revision, bindingGeneration: 1 },
      payload: { resultId: result.id, sessionId: attempt.sessionId, instruction: "Immediate only", path: "instruction" },
    });

    // Then
    assert.equal(receipt.error?.code, "instruction_timing_unsupported");
    assert.equal(context.hub.simulator?.calls.list()
      .filter((call) => call.operationKind === "runtime.sendInstruction").length, 0);
  } finally {
    context.close();
  }
});

test("continuation refuses a disabled current profile before creating an attempt", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "review-disabled");
    const first = await delegateNone(context.hub, taskId, "review-disabled");
    await finishAttempt(context.hub, first);
    await context.hub.execute(admin, {
      commandId: "disable-review-profile",
      type: "profile.disable",
      target: { kind: "profile", id: "profile-structured" },
      expected: { profile: 1 },
      payload: {},
    });
    const session = context.hub.getSession(member, first.sessionId).session;
    const before = context.hub.snapshot(member).attempts.length;

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "continue-disabled-profile",
      type: "session.continue",
      target: { kind: "session", id: session.id },
      expected: { session: session.revision, task: context.hub.getTask(member, taskId).revision, profile: 2 },
      payload: { profileId: "profile-structured", context: "current_task", environmentReuse: "reuse", instruction: "Must not start" },
    });

    // Then
    assert.equal(receipt.error?.code, "profile_disabled");
    assert.equal(context.hub.snapshot(member).attempts.length, before);
  } finally {
    context.close();
  }
});

test("retry rejects unsupported recovery references instead of bypassing unresolved work", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "review-recovery");
    const attempt = await delegateNone(context.hub, taskId, "review-recovery");
    const before = context.hub.snapshot(member).attempts.length;

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "retry-arbitrary-recovery",
      type: "attempt.retry",
      target: { kind: "attempt", id: attempt.id },
      expected: { task: context.hub.getTask(member, taskId).revision, profile: 1 },
      payload: { predecessorId: attempt.id, input: "snapshot", recoveryDecisionId: "arbitrary", sameSession: true },
    });

    // Then
    assert.equal(receipt.error?.code, "recovery_decision_unsupported");
    assert.equal(context.hub.snapshot(member).attempts.length, before);
  } finally {
    context.close();
  }
});

test("continuation reattach is explicitly refused without creating work", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "review-reattach");
    const first = await delegateNone(context.hub, taskId, "review-reattach");
    await finishAttempt(context.hub, first);
    const session = context.hub.getSession(member, first.sessionId).session;
    const before = context.hub.snapshot(member).attempts.length;

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "continue-reattach-unsupported",
      type: "session.continue",
      target: { kind: "session", id: session.id },
      expected: {
        session: session.revision,
        task: context.hub.getTask(member, taskId).revision,
        profile: 1,
      },
      payload: {
        profileId: "profile-structured",
        context: "snapshot",
        environmentReuse: "reattach",
        instruction: "Do not silently drop the environment",
      },
    });

    // Then
    assert.equal(receipt.error?.code, "continuation_reattach_unsupported");
    assert.equal(context.hub.snapshot(member).attempts.length, before);
  } finally {
    context.close();
  }
});
