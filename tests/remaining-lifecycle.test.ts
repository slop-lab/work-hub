import assert from "node:assert/strict";
import { test } from "node:test";

import { admin, createTask, delegateNone, drainIdle, finishAttempt, fixture, member,
  provisionedArea } from "./acceptance-fixture.ts";

test("new-session retry can hand off to an explicit current profile on another runtime", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "retry-other-runtime");
    const predecessor = await delegateNone(context.hub, taskId, "retry-other-runtime");
    await finishAttempt(context.hub, predecessor);
    const receipt = await context.hub.execute(member, { commandId: "retry-other-runtime",
      type: "attempt.retry", target: { kind: "attempt", id: predecessor.id },
      expected: { task: context.hub.getTask(member, taskId).revision, profile: 1 },
      payload: { predecessorId: predecessor.id, profileId: "profile-limited",
        input: "current_task", sameSession: false, environment: { mode: "none" } } });
    assert.equal(receipt.status, "accepted");
    await drainIdle(context.hub);
    const attemptId = receipt.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    const attempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attemptId);
    assert.ok(attempt);
    const session = context.hub.getSession(member, attempt.sessionId).session;
    assert.equal(attempt.profileId, "profile-limited");
    assert.equal(session.runtimeInstallationId, "runtime-sim-limited");
    assert.equal(attempt.phase, "running");
  } finally { context.close(); }
});

test("disabled execution installation rejects retry before creating records or allocation calls", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "retry-disabled-execution");
    const predecessor = await delegateNone(context.hub, taskId, "retry-disabled-execution");
    await finishAttempt(context.hub, predecessor);
    await context.hub.execute(admin, { commandId: "disable-retry-execution",
      type: "installation.disable", target: { kind: "installation", id: "execution-sim" },
      payload: { expectedRevision: 1 } });
    const before = context.hub.snapshot(member);
    const allocationCalls = context.hub.simulator?.calls.list()
      .filter((call) => call.operationKind === "execution.requestAllocation").length ?? 0;
    const receipt = await context.hub.execute(member, { commandId: "retry-disabled-execution",
      type: "attempt.retry", target: { kind: "attempt", id: predecessor.id },
      expected: { task: context.hub.getTask(member, taskId).revision, profile: 1 },
      payload: { predecessorId: predecessor.id, input: "current_task", sameSession: false,
        environment: { mode: "provision", executionInstallationId: "execution-sim",
          externalProfileRef: "small", parameters: {}, releasePolicyRef: "retain",
          workAreas: [provisionedArea] } } });
    assert.equal(receipt.error?.code, "connector_disabled");
    const after = context.hub.snapshot(member);
    assert.equal(after.attempts.length, before.attempts.length);
    assert.equal(after.sessions.length, before.sessions.length);
    assert.equal(after.environmentBindings.length, before.environmentBindings.length);
    assert.equal(context.hub.simulator?.calls.list()
      .filter((call) => call.operationKind === "execution.requestAllocation").length,
      allocationCalls);
  } finally { context.close(); }
});

test("closing observation requires continuation acknowledgment and records stale observation without termination", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "close-observed");
    const nativeSession = { installationId: "runtime-sim-structured", providerScope: "simulated",
      kind: "agent-session", id: "observed-close", incarnation: "v1" } as const;
    const attached = await context.hub.execute(member, { commandId: "attach-observed-close",
      type: "session.attach", target: { kind: "task", id: taskId },
      expected: { task: 1, profile: 1 }, payload: { profileId: "profile-structured",
        controlMode: "control", nativeSession, environment: { mode: "none" } } });
    const sessionId = attached.objectRefs.find((reference) => reference.kind === "session")?.id;
    assert.ok(sessionId);
    context.hub.simulator?.controls.seedSession({ hubSessionId: sessionId,
      nativeSession, controlMode: "control", phase: "running", hubAttemptId: "external-work" });
    await drainIdle(context.hub);
    const session = context.hub.getSession(member, sessionId).session;
    const rejected = await context.hub.execute(member, { commandId: "close-observed-without-decision",
      type: "session.close", target: { kind: "session", id: sessionId },
      expected: { session: session.revision }, payload: {} });
    assert.equal(rejected.error?.code, "external_work_decision_required");
    const accepted = await context.hub.execute(member, { commandId: "close-observed-continues",
      type: "session.close", target: { kind: "session", id: sessionId },
      expected: { session: session.revision }, payload: { externalWorkDecision: "continues" } });
    assert.equal(accepted.status, "accepted");
    await drainIdle(context.hub);
    const attempt = context.hub.snapshot(member).attempts.find((candidate) =>
      candidate.sessionId === sessionId && candidate.role === "observed");
    assert.ok(attempt);
    assert.equal(context.hub.getSession(member, sessionId).session.lifecycle, "closed");
    assert.equal(attempt.unresolved, true);
    assert.equal(attempt.observation, "stale");
    assert.ok(attempt.observationEndedAt);
    assert.equal(attempt.outcome, undefined);
  } finally { context.close(); }
});

test("environment-free native session attach failure closes the opening session", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "attach-none-failure");
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.scriptNext("runtime.openSession", { kind: "definite_failure" });
    const receipt = await context.hub.execute(member, { commandId: "attach-none-failure",
      type: "session.attach", target: { kind: "task", id: taskId },
      expected: { task: 1, profile: 1 }, payload: { profileId: "profile-structured",
        controlMode: "control", nativeSession: { installationId: "runtime-sim-structured",
          providerScope: "simulated", kind: "agent-session", id: "attach-none-failure", incarnation: "v1" },
        environment: { mode: "none" } } });
    await drainIdle(context.hub);
    const sessionId = receipt.objectRefs.find((reference) => reference.kind === "session")?.id;
    assert.ok(sessionId);
    assert.equal(context.hub.getSession(member, sessionId).session.lifecycle, "closed");
  } finally { context.close(); }
});
