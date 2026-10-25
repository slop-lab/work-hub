import assert from "node:assert/strict";
import test from "node:test";

import { NativeRefSchema } from "../application/contracts/index.ts";
import type { AttemptView, SessionView } from "../application/domain/model.ts";
import type { Hub } from "../application/orchestration/hub.ts";
import { createTask, delegateNone, drainIdle, finishAttempt, fixture, member } from "./acceptance-fixture.ts";

async function agentQuestion(hub: Hub, attempt: AttemptView, session: SessionView, suffix: string) {
  const nativeSession = NativeRefSchema.parse(JSON.parse(session.nativeIdentityKey ?? "null"));
  const receipt = await hub.execute(member, {
    commandId: `agent-question-${suffix}`, type: "request.create",
    payload: { kind: "question", projectId: session.projectId, taskId: attempt.taskId,
      sessionId: session.id, attemptId: attempt.id, bindingGeneration: session.bindingGeneration,
      recipient: { kind: "agent_session", sessionId: session.id }, prompt: "Need operator context",
      referenceIds: [], answerSchema: { kind: "text", minLength: 1, maxLength: 100 },
      blocking: "none", responseRoute: "none",
      validity: { kind: "attempt", target: { hubSessionId: session.id,
        hubAttemptId: attempt.id, nativeSession, bindingGeneration: session.bindingGeneration,
        controlGrantRef: `control:${session.id}` } } },
  });
  const requestId = receipt.objectRefs[0]?.id;
  assert.ok(requestId);
  return requestId;
}

test("ending an attempt expires its exact open agent-session questions", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "terminal-agent-question");
    const attempt = await delegateNone(context.hub, taskId, "terminal-agent-question");
    const session = context.hub.getSession(member, attempt.sessionId).session;
    const requestId = await agentQuestion(context.hub, attempt, session, "attempt-end");

    // When
    await finishAttempt(context.hub, attempt);

    // Then
    assert.equal(context.hub.getRequest(member, requestId).status, "expired");
  } finally {
    context.close();
  }
});

test("closing an attached session expires its open agent-session questions", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "closed-agent-question");
    const nativeSession = { installationId: "runtime-sim-structured", providerScope: "simulated",
      kind: "agent-session", id: "closed-question-session", incarnation: "v1" };
    const attached = await context.hub.execute(member, {
      commandId: "attach-closed-agent-question", type: "session.attach",
      target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
      payload: { profileId: "profile-structured", controlMode: "observe", nativeSession,
        environment: { mode: "none" } },
    });
    const sessionId = attached.objectRefs[0]?.id;
    assert.ok(sessionId);
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    simulator.controls.seedSession({ hubSessionId: sessionId, nativeSession, controlMode: "observe",
      phase: "running", hubAttemptId: "provider-attempt", history: "partial" });
    await drainIdle(context.hub);
    const attempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.sessionId === sessionId);
    assert.ok(attempt);
    const session = context.hub.getSession(member, sessionId).session;
    const requestId = await agentQuestion(context.hub, attempt, session, "session-close");

    // When
    await context.hub.execute(member, { commandId: "close-agent-question-session",
      type: "session.close", target: { kind: "session", id: session.id },
      expected: { session: session.revision }, payload: { externalWorkDecision: "continues" } });
    await drainIdle(context.hub);

    // Then
    assert.equal(context.hub.getRequest(member, requestId).status, "expired");
  } finally {
    context.close();
  }
});
