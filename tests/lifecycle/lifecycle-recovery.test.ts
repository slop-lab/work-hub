import assert from "node:assert/strict";
import { test } from "node:test";

import { createTask, delegateNone, drainIdle, finishAttempt, fixture, member } from "../acceptance-fixture.ts";

test("controlled retry creates linked work with the predecessor profile by default", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "controlled-retry-linked");
    const predecessor = await delegateNone(context.hub, taskId, "controlled-retry-linked");
    await context.hub.execute(member, {
      commandId: "reconcile-controlled-retry-linked",
      type: "attempt.reconcile",
      target: { kind: "attempt", id: predecessor.id },
      payload: { interruption: "retryable_failure", recovery: "reconcile",
        note: "The transient provider failure is terminal and safe to retry." },
    });
    await finishAttempt(context.hub, predecessor, "failed");

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "controlled-retry-linked",
      type: "attempt.controlledResume",
      target: { kind: "attempt", id: predecessor.id },
      payload: { recovery: "retry", reason: "Retry the transient provider failure.", retryLimit: 2 },
    });

    // Then
    assert.equal(receipt.status, "accepted");
    const attemptId = receipt.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(attemptId);
    assert.notEqual(attemptId, predecessor.id);
    const retried = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attemptId);
    assert.ok(retried);
    assert.equal(retried.predecessorId, predecessor.id);
    assert.equal(retried.profileId, predecessor.profileId);
    assert.equal(retried.profileRevision, predecessor.profileRevision);
    assert.equal(retried.interruption, undefined);
    assert.equal(retried.recovery, "retry");
    assert.equal(receipt.operationIds.length, 1);
    const oldSession = context.hub.getSession(member, predecessor.sessionId).session;
    const obsoleteContinuation = await context.hub.execute(member, {
      commandId: "continue-obsolete-retry-session",
      type: "session.continue",
      target: { kind: "session", id: oldSession.id },
      expected: { session: oldSession.revision, task: context.hub.getTask(member, taskId).revision,
        profile: predecessor.profileRevision },
      payload: { profileId: predecessor.profileId, context: "snapshot", environmentReuse: "reuse",
        instruction: "Must not replace the current retry." },
    });
    assert.equal(obsoleteContinuation.error?.code, "continuation_target_obsolete");
    const obsolete = await context.hub.execute(member, {
      commandId: "direct-retry-obsolete-predecessor",
      type: "attempt.retry",
      target: { kind: "attempt", id: predecessor.id },
      expected: { task: context.hub.getTask(member, taskId).revision, profile: predecessor.profileRevision },
      payload: { predecessorId: predecessor.id, input: "snapshot", reason: "Must not replace current retry.",
        retryLimit: 2, sameSession: false },
    });
    assert.equal(obsolete.error?.code, "retry_target_obsolete");
  } finally {
    context.close();
  }
});

test("controlled resume retains an established retry budget", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "resume-retains-retry-budget");
    const predecessor = await delegateNone(context.hub, taskId, "resume-retains-retry-budget");
    await context.hub.execute(member, { commandId: "reconcile-budget-predecessor", type: "attempt.reconcile",
      target: { kind: "attempt", id: predecessor.id }, payload: { interruption: "retryable_failure",
        recovery: "reconcile", note: "Establish a bounded retry." } });
    await finishAttempt(context.hub, predecessor, "failed");
    const retry = await context.hub.execute(member, { commandId: "retry-budget-predecessor",
      type: "attempt.controlledResume", target: { kind: "attempt", id: predecessor.id },
      payload: { recovery: "retry", reason: "First retry.", retryLimit: 2 } });
    const retryId = retry.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(retryId);
    await drainIdle(context.hub);
    const retried = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === retryId);
    assert.ok(retried);
    await context.hub.execute(member, { commandId: "reconcile-budget-retry", type: "attempt.reconcile",
      target: { kind: "attempt", id: retryId }, payload: { interruption: "paused",
        recovery: "reconcile", note: "Resume without resetting the budget." } });
    await finishAttempt(context.hub, retried, "stopped");

    const resume = await context.hub.execute(member, { commandId: "resume-retained-budget",
      type: "attempt.controlledResume", target: { kind: "attempt", id: retryId },
      payload: { recovery: "resume", reason: "Continue with retained budget.", retryLimit: 2 } });
    const resumedId = resume.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(resumedId);
    const resumed = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === resumedId);
    assert.equal(resumed?.retryOrdinal, 1);
    assert.equal(resumed?.retryLimit, 2);
  } finally { context.close(); }
});

test("controlled resume creates a linked continuation in the retained session", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "controlled-resume-linked");
    const predecessor = await delegateNone(context.hub, taskId, "controlled-resume-linked");
    await context.hub.execute(member, {
      commandId: "reconcile-controlled-resume-linked",
      type: "attempt.reconcile",
      target: { kind: "attempt", id: predecessor.id },
      payload: { interruption: "paused", recovery: "reconcile",
        note: "The pause ended without uncertain input." },
    });
    await finishAttempt(context.hub, predecessor, "stopped");

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "controlled-resume-linked",
      type: "attempt.controlledResume",
      target: { kind: "attempt", id: predecessor.id },
      payload: { recovery: "resume", reason: "Continue the retained task scope.", retryLimit: 0 },
    });

    // Then
    assert.equal(receipt.status, "accepted");
    const attemptId = receipt.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(attemptId);
    assert.notEqual(attemptId, predecessor.id);
    const resumed = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attemptId);
    assert.ok(resumed);
    assert.equal(resumed.predecessorId, predecessor.id);
    assert.equal(resumed.sessionId, predecessor.sessionId);
    assert.equal(resumed.profileId, predecessor.profileId);
    assert.equal(resumed.recovery, "resume");
    assert.equal(resumed.interruption, undefined);
    assert.equal(receipt.operationIds.length, 1);
  } finally {
    context.close();
  }
});

test("blockers and interrupted attempts keep explicit recovery and bounded retry state", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "lifecycle-recovery");
    const attempt = await delegateNone(context.hub, taskId, "lifecycle-recovery");
    const opened = await context.hub.execute(member, {
      commandId: "blocker-open-lifecycle-recovery",
      type: "blocker.open",
      target: { kind: "task", id: taskId },
      payload: { attemptId: attempt.id, kind: "external_dependency", owner: "release-engineering",
        remedy: "Publish the signed fixture.", detail: "The verifier fixture is not available yet." },
    });
    const blockerId = opened.objectRefs[0]?.id;
    assert.ok(blockerId);
    await context.hub.execute(member, {
      commandId: "attempt-reconcile-lifecycle-recovery",
      type: "attempt.reconcile",
      target: { kind: "attempt", id: attempt.id },
      payload: { interruption: "retryable_failure", recovery: "reconcile",
        note: "Provider reported a transient failure." },
    });
    await finishAttempt(context.hub, attempt, "failed");

    // When
    const resumed = await context.hub.execute(member, {
      commandId: "attempt-resume-lifecycle-recovery",
      type: "attempt.controlledResume",
      target: { kind: "attempt", id: attempt.id },
      payload: { recovery: "retry", reason: "Retry after dependency publication.", retryLimit: 1 },
    });
    const retryId = resumed.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(retryId);
    await context.hub.execute(member, {
      commandId: "attempt-reconcile-retry-lifecycle-recovery",
      type: "attempt.reconcile",
      target: { kind: "attempt", id: retryId },
      payload: { interruption: "retryable_failure", recovery: "reconcile", note: "Retry also ended transiently." },
    });
    const retryAttempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === retryId);
    assert.ok(retryAttempt);
    await drainIdle(context.hub);
    await finishAttempt(context.hub, retryAttempt, "failed");
    const exhausted = await context.hub.execute(member, {
      commandId: "attempt-resume-exhausted-lifecycle-recovery",
      type: "attempt.controlledResume",
      target: { kind: "attempt", id: retryId },
      payload: { recovery: "retry", reason: "Second retry must not exceed budget.", retryLimit: 1 },
    });
    const raised = await context.hub.execute(member, {
      commandId: "attempt-resume-raised-budget-lifecycle-recovery",
      type: "attempt.controlledResume",
      target: { kind: "attempt", id: retryId },
      payload: { recovery: "retry", reason: "The retained budget cannot be raised.", retryLimit: 2 },
    });
    const escalatedRaised = await context.hub.execute(member, {
      commandId: "attempt-escalated-raised-budget-lifecycle-recovery",
      type: "attempt.controlledResume",
      target: { kind: "attempt", id: retryId },
      payload: { recovery: "escalated", reason: "Escalation must retain the established budget.", retryLimit: 2 },
    });
    const directRaised = await context.hub.execute(member, {
      commandId: "attempt-direct-raised-budget-lifecycle-recovery",
      type: "attempt.retry",
      target: { kind: "attempt", id: retryId },
      expected: { task: context.hub.getTask(member, taskId).revision, profile: retryAttempt.profileRevision },
      payload: { predecessorId: retryId, input: "snapshot", reason: "Direct retry must retain the budget.",
        retryLimit: 2, sameSession: false },
    });
    await context.hub.execute(member, { commandId: "blocker-resolve-lifecycle-recovery",
      type: "blocker.resolve", target: { kind: "blocker", id: blockerId },
      payload: { resolution: "Fixture published." } });
    await context.hub.execute(member, { commandId: "blocker-recheck-lifecycle-recovery",
      type: "blocker.recheck", target: { kind: "blocker", id: blockerId },
      payload: { note: "Recheck scheduled without fabricating provider success." } });

    // Then
    assert.equal(resumed.status, "accepted");
    assert.equal(exhausted.error?.code, "retry_budget_exhausted");
    assert.equal(raised.error?.code, "retry_budget_fixed");
    assert.equal(escalatedRaised.error?.code, "retry_budget_fixed");
    assert.equal(directRaised.error?.code, "retry_budget_fixed");
    const lifecycle = context.hub.getTaskLifecycle(member, taskId);
    assert.equal(lifecycle.blockers[0]?.status, "rechecking");
    assert.equal(lifecycle.projection.currentMissingAction, "resolve_blocker");
    const currentAttempt = lifecycle.attempts.find((candidate) => candidate.id === retryId);
    assert.equal(currentAttempt?.interruption, "crash");
    assert.equal(currentAttempt?.recovery, "reconcile");
    assert.equal(currentAttempt?.retry.ordinal, 1);
    assert.equal(currentAttempt?.retry.limit, 1);
  } finally {
    context.close();
  }
});
