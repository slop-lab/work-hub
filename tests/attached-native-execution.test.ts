import assert from "node:assert/strict";
import test from "node:test";

import { createTask, drainIdle, fixture, member } from "./acceptance-fixture.ts";

function nativeExecutionId(input: Readonly<Record<string, unknown>>): unknown {
  const target = input["target"];
  if (typeof target !== "object" || target === null) return undefined;
  const nativeExecution = Reflect.get(target, "nativeExecutionRef");
  return typeof nativeExecution === "object" && nativeExecution !== null
    ? Reflect.get(nativeExecution, "id")
    : undefined;
}

test("attached session instruction and stop target the inspected native execution", async () => {
  // Given
  const context = fixture();
  try {
    const simulator = context.hub.simulator;
    assert.ok(simulator);
    const taskId = await createTask(context.hub, "attached-native-execution");
    const nativeSession = { installationId: "runtime-sim-structured", providerScope: "simulated",
      kind: "agent-session", id: "attached-native-session", incarnation: "v1" };
    const nativeExecutionRef = { installationId: "runtime-sim-structured", providerScope: "simulated",
      kind: "execution", id: "attached-native-execution", incarnation: "v4" };
    const attached = await context.hub.execute(member, {
      commandId: "attach-native-execution", type: "session.attach",
      target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
      payload: { profileId: "profile-structured", controlMode: "control", nativeSession,
        environment: { mode: "none" } },
    });
    const sessionId = attached.objectRefs[0]?.id;
    assert.ok(sessionId);
    simulator.controls.seedSession({ hubSessionId: sessionId, nativeSession, controlMode: "control",
      phase: "running", hubAttemptId: "provider-attempt", nativeExecutionRef, history: "partial" });
    await drainIdle(context.hub);
    const attempt = context.hub.snapshot(member).attempts.find((candidate) => candidate.sessionId === sessionId);
    assert.ok(attempt);
    simulator.controls.seedSession({ hubSessionId: sessionId, nativeSession, controlMode: "control",
      phase: "running", hubAttemptId: attempt.id, nativeExecutionRef, history: "partial" });

    // When
    await context.hub.execute(member, {
      commandId: "instruct-attached-native-execution", type: "session.instruct",
      target: { kind: "session", id: sessionId }, expected: { bindingGeneration: 1 },
      payload: { attemptId: attempt.id, text: "Continue attached work", referenceIds: [], mode: "immediate" },
    });
    await drainIdle(context.hub);
    await context.hub.execute(member, {
      commandId: "stop-attached-native-execution", type: "attempt.stop",
      target: { kind: "attempt", id: attempt.id }, expected: { bindingGeneration: 1 },
      payload: { mode: "stop_work", reason: "Review complete" },
    });
    await drainIdle(context.hub);

    // Then
    const instruction = simulator.calls.list()
      .find((call) => call.operationKind === "runtime.sendInstruction");
    const stop = simulator.calls.list().find((call) => call.operationKind === "runtime.requestStop");
    assert.ok(instruction);
    assert.ok(stop);
    assert.equal(nativeExecutionId(instruction.input), nativeExecutionRef.id);
    assert.equal(nativeExecutionId(stop.input), nativeExecutionRef.id);
  } finally {
    context.close();
  }
});
