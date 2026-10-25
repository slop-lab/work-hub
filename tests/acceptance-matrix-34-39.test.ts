import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { Hub } from "../application/orchestration/hub.ts";
import {
  admin, createTask, delegateNone, drainIdle, finishAttempt, fixture, member,
  operationKinds,
} from "./acceptance-fixture.ts";

test("AT-34 a late old result is retained without replacing a newer primary attempt or human intent", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "34");
    const first = await delegateNone(context.hub, taskId, "34");
    await finishAttempt(context.hub, first);
    const session = context.hub.getSession(member, first.sessionId).session;
    const continued = await context.hub.execute(member, { commandId: "continue-34", type: "session.continue", target: { kind: "session", id: session.id }, expected: { session: session.revision, task: context.hub.getTask(member, taskId).revision, profile: 1 }, payload: { profileId: "profile-structured", context: "current_task", environmentReuse: "reuse", instruction: "Newer work" } });
    await drainIdle(context.hub);
    const nextId = continued.objectRefs[0]?.id;
    assert.ok(nextId);
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.emitResult({ hubSessionId: session.id, hubAttemptId: first.id, bindingGeneration: 1, summary: "Late older result", referenceIds: [] });
    await context.hub.reconcile();
    const task = context.hub.getTask(member, taskId);
    assert.equal(task.primaryAttemptId, nextId);
    assert.equal(task.status, "active");
    assert.equal(context.hub.snapshot(member).results.some((result) => result.attemptId === first.id && result.summary === "Late older result"), true);
  } finally { context.close(); }
});

test("AT-35 task and profile edits cannot rewrite a running attempt's immutable snapshot", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "35");
    const attempt = await delegateNone(context.hub, taskId, "35");
    const before = JSON.stringify(attempt.inputSnapshot);
    await context.hub.execute(member, { commandId: "edit-task-35", type: "task.update", target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision }, payload: { title: "Changed after delegation" } });
    await context.hub.execute(admin, { commandId: "edit-profile-35", type: "profile.update", target: { kind: "profile", id: "profile-structured" }, expected: { profile: 1 }, payload: { configuration: { changed: true } } });
    const after = context.hub.snapshot(member).attempts.find((item) => item.id === attempt.id);
    assert.ok(after);
    assert.equal(JSON.stringify(after.inputSnapshot), before);
    assert.equal(after.profileRevision, 1);
    assert.equal(context.hub.getTask(member, taskId).title, "Changed after delegation");
  } finally { context.close(); }
});

test("AT-36 retry handoff creates a new logical session and does not claim native-state migration", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "36");
    const reference = await context.hub.execute(member, { commandId: "reference-36", type: "reference.create", target: { kind: "task", id: taskId }, payload: { kind: "text", title: "Original reference", content: "original retained context" } });
    const referenceId = reference.objectRefs[0]?.id; assert.ok(referenceId);
    const delegated = await context.hub.execute(member, { commandId: "delegate-36", type: "attempt.delegate", target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision, profile: 1 }, payload: { profileId: "profile-structured", environment: { mode: "none" }, instruction: "Original retry instruction", selectedReferenceIds: [referenceId], selectedResponseIds: [], authorizedEffectKinds: ["task.read"] } });
    assert.equal(delegated.status, "accepted");
    await drainIdle(context.hub);
    const first = context.hub.snapshot(member).attempts.find((item) => item.id === delegated.objectRefs[0]?.id); assert.ok(first);
    const originalSnapshot = first.inputSnapshot;
    await finishAttempt(context.hub, first);
    await context.hub.execute(member, { commandId: "edit-task-36", type: "task.update", target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision }, payload: { title: "Current task must not replace snapshot" } });
    await context.hub.execute(admin, { commandId: "restrict-profile-36", type: "profile.update", target: { kind: "profile", id: "profile-structured" }, expected: { profile: 1 }, payload: { allowedEffects: [] } });
    const receipt = await context.hub.execute(member, { commandId: "handoff-36", type: "attempt.retry", target: { kind: "attempt", id: first.id }, expected: { task: context.hub.getTask(member, taskId).revision, profile: 2 }, payload: { predecessorId: first.id, input: "snapshot", sameSession: false } });
    assert.equal(receipt.status, "accepted");
    await drainIdle(context.hub);
    const next = context.hub.snapshot(member).attempts.find((item) => item.id === receipt.objectRefs[0]?.id);
    assert.ok(next);
    assert.notEqual(next.sessionId, first.sessionId);
    assert.equal(next.predecessorId, first.id);
    assert.equal(context.hub.getSession(member, next.sessionId).session.predecessorId, first.sessionId);
    assert.equal(next.profileRevision, 2);
    assert.equal(next.inputSnapshot["instruction"], originalSnapshot["instruction"]);
    assert.deepEqual(next.inputSnapshot["selectedReferenceIds"], originalSnapshot["selectedReferenceIds"]);
    assert.deepEqual(next.inputSnapshot["selectedResponseIds"], originalSnapshot["selectedResponseIds"]);
    assert.deepEqual(next.inputSnapshot["contextItems"], originalSnapshot["contextItems"]);
    assert.equal(next.inputSnapshot["taskRevision"], originalSnapshot["taskRevision"]);
    assert.equal(next.inputSnapshot["profileRevision"], originalSnapshot["profileRevision"]);
    assert.deepEqual(next.inputSnapshot["authorizedEffectKinds"], []);
    assert.notEqual(next.inputSnapshot["id"], originalSnapshot["id"]);
    assert.notEqual(next.inputSnapshot["digest"], originalSnapshot["digest"]);
    const oldNative = context.hub.getSession(member, first.sessionId).session.nativeIdentityKey;
    const newNative = context.hub.getSession(member, next.sessionId).session.nativeIdentityKey;
    assert.notEqual(newNative, oldNative);
  } finally { context.close(); }
});

test("AT-36 current-task retry assembles edited task context instead of copying the predecessor snapshot", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "36-current");
    const first = await delegateNone(context.hub, taskId, "36-current");
    await finishAttempt(context.hub, first);
    await context.hub.execute(member, { commandId: "edit-task-36-current", type: "task.update", target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision }, payload: { title: "Edited current retry title", description: "Edited current retry description" } });
    const task = context.hub.getTask(member, taskId);
    const receipt = await context.hub.execute(member, { commandId: "handoff-36-current", type: "attempt.retry", target: { kind: "attempt", id: first.id }, expected: { task: task.revision, profile: 1 }, payload: { predecessorId: first.id, input: "current_task", sameSession: false } });
    assert.equal(receipt.status, "accepted");
    const next = context.hub.snapshot(member).attempts.find((item) => item.id === receipt.objectRefs[0]?.id); assert.ok(next);
    assert.equal(next.inputSnapshot["instruction"], "Edited current retry title\n\nEdited current retry description");
    assert.deepEqual(next.inputSnapshot["selectedReferenceIds"], []);
    assert.deepEqual(next.inputSnapshot["selectedResponseIds"], []);
    assert.equal(next.inputSnapshot["taskRevision"], task.revision);
    assert.equal(next.inputSnapshot["profileRevision"], 1);
    const taskContext = Array.isArray(next.inputSnapshot["contextItems"]) ? next.inputSnapshot["contextItems"].find((item) => typeof item === "object" && item !== null && Reflect.get(item, "sourceId") === taskId) : undefined;
    assert.ok(taskContext);
    assert.match(String(Reflect.get(taskContext, "includedText")), /Edited current retry title/);
  } finally { context.close(); }
});

test("AT-36 retry cannot implicitly reopen done, canceled, or archived tasks", async (testContext) => {
  for (const state of ["done", "canceled", "archived"] as const) {
    await testContext.test(state, async () => {
      const context = fixture();
      try {
        const taskId = await createTask(context.hub, `36-${state}`);
        const first = await delegateNone(context.hub, taskId, `36-${state}`);
        await finishAttempt(context.hub, first);
        const task = context.hub.getTask(member, taskId);
        if (state === "archived") await context.hub.execute(member, { commandId: `close-36-${state}`, type: "task.archive", target: { kind: "task", id: taskId }, expected: { task: task.revision }, payload: {} });
        else await context.hub.execute(member, { commandId: `close-36-${state}`, type: "task.setStatus", target: { kind: "task", id: taskId }, expected: { task: task.revision }, payload: { status: state } });
        const closed = context.hub.getTask(member, taskId);
        const before = context.hub.snapshot(member).attempts.length;
        const receipt = await context.hub.execute(member, { commandId: `retry-36-${state}`, type: "attempt.retry", target: { kind: "attempt", id: first.id }, expected: { task: closed.revision, profile: 1 }, payload: { predecessorId: first.id, input: "snapshot", sameSession: false } });
        assert.equal(receipt.error?.code, "task_not_delegable");
        assert.equal(context.hub.snapshot(member).attempts.length, before);
      } finally { context.close(); }
    });
  }
});

test("AT-36 retry requires current task and profile revisions", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "36-revisions");
    const first = await delegateNone(context.hub, taskId, "36-revisions");
    await finishAttempt(context.hub, first);
    const before = context.hub.snapshot(member).attempts.length;
    const receipt = await context.hub.execute(member, { commandId: "retry-36-missing-revisions", type: "attempt.retry", target: { kind: "attempt", id: first.id }, payload: { predecessorId: first.id, input: "snapshot", sameSession: false } });
    assert.equal(receipt.error?.code, "expected_revision_required");
    assert.equal(context.hub.snapshot(member).attempts.length, before);
  } finally { context.close(); }
});

test("AT-37 restart after a side effect reconciles the same operation without blind replay", async () => {
  const context = fixture();
  let restored: Hub | undefined;
  try {
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("runtime.openSession", { kind: "unknown_after_effect" });
    const taskId = await createTask(context.hub, "37");
    await context.hub.execute(member, { commandId: "delegate-37", type: "attempt.delegate", target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: "profile-structured", environment: { mode: "none" }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] } });
    await context.hub.drain({ limit: 1 });
    assert.equal(operationKinds(context.hub).filter((kind) => kind === "runtime.openSession").length, 1);
    context.hub.close();
    restored = new Hub(context.path);
    await drainIdle(restored);
    assert.equal(operationKinds(restored).filter((kind) => kind === "runtime.openSession").length, 1);
    assert.equal(restored.snapshot(member).attempts[0]?.phase, "running");
  } finally { restored?.close(); rmSync(context.root, { recursive: true, force: true }); }
});

test("AT-38 replay after restart deduplicates canonical requests and exposes history gaps", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "38");
    const attempt = await delegateNone(context.hub, taskId, "38");
    const session = context.hub.getSession(member, attempt.sessionId).session;
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.emitQuestion({ hubSessionId: session.id, hubAttemptId: attempt.id, requestId: "stable-request-38", projectId: "project-default", taskId, recipient: { kind: "user", userId: "user-admin" }, bindingGeneration: 1, prompt: "One canonical question", responseRoute: "native", blocking: "runtime_action" });
    simulator.controls.addHistoryGap(session.id, "retention-window-expired");
    await context.hub.reconcile();
    await context.hub.reconcile();
    assert.equal(context.hub.getSession(admin, session.id).requests.length, 1);
    const output = context.hub.getSession(admin, session.id).output;
    assert.equal(output.some((item) => typeof item["itemJson"] === "string" && item["itemJson"].includes("retention-window-expired")), true);
  } finally { context.close(); }
});

test("AT-39 a disappeared native session preserves local history and is never recreated automatically", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "39");
    const attempt = await delegateNone(context.hub, taskId, "39");
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    const beforeOpenCalls = operationKinds(context.hub).filter((kind) => kind === "runtime.openSession").length;
    simulator.controls.setSessionMissing(attempt.sessionId);
    await context.hub.reconcile();
    assert.equal(context.hub.getTask(member, taskId).title, "Acceptance 39");
    assert.equal(context.hub.getSession(member, attempt.sessionId).session.nativeIdentityKey !== undefined, true);
    assert.equal(operationKinds(context.hub).filter((kind) => kind === "runtime.openSession").length, beforeOpenCalls);
    assert.equal(context.hub.snapshot(member).attempts.find((item) => item.id === attempt.id)?.observation, "unreachable");
  } finally { context.close(); }
});
