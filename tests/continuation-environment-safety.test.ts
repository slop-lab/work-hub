import assert from "node:assert/strict";
import test from "node:test";

import {
  createTask,
  delegateExisting,
  finishAttempt,
  fixture,
  member,
  registerReadyEnvironment,
} from "./acceptance-fixture.ts";

test("continuation refuses an attached environment observed missing after its predecessor ended", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "continued-environment-missing");
    const registrationId = await registerReadyEnvironment(
      context.hub, "continued-environment-missing",
    );
    const delegated = await delegateExisting(
      context.hub, taskId, registrationId, "continued-environment-missing",
    );
    const attemptId = delegated.objectRefs.find((reference) => reference.kind === "attempt")?.id;
    assert.ok(attemptId);
    const attempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attemptId);
    assert.ok(attempt);
    await finishAttempt(context.hub, attempt);
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.setEnvironment(registrationId, { state: "missing", assurance: "immutable",
      externalActivity: "idle", incarnation: "incarnation-1" });
    await context.hub.reconcile();
    const session = context.hub.getSession(member, attempt.sessionId).session;
    const before = context.hub.snapshot(member).attempts.length;

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "continue-missing-environment", type: "session.continue",
      target: { kind: "session", id: session.id },
      expected: { session: session.revision, task: context.hub.getTask(member, taskId).revision,
        profile: 1 },
      payload: { profileId: "profile-structured", context: "current_task",
        environmentReuse: "reuse", instruction: "Do not run in the missing environment" },
    });

    // Then
    assert.equal(receipt.error?.code, "environment_observation_unsafe");
    assert.equal(context.hub.snapshot(member).attempts.length, before);
  } finally {
    context.close();
  }
});
