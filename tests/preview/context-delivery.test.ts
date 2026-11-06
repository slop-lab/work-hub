import assert from "node:assert/strict";
import test from "node:test";
import { admin, createTask, delegateNone, drainIdle, fixture } from "../acceptance-fixture.ts";

test("task and session contexts retain acknowledged native answer deliveries", async () => {
  // Given an actual canonical question and a committed, acknowledged answer.
  const app = fixture();
  try {
    const taskId = await createTask(app.hub, "preview-context-delivery", admin);
    const attempt = await delegateNone(app.hub, taskId, "preview-context-delivery");
    const session = app.hub.getSession(admin, attempt.sessionId).session;
    assert.ok(app.hub.simulator);
    app.hub.simulator.controls.emitQuestion({ hubSessionId: session.id, hubAttemptId: attempt.id,
      bindingGeneration: session.bindingGeneration, requestId: "preview-context-question",
      projectId: "project-default", taskId, recipient: { kind: "user", userId: admin.id },
      prompt: "Continue this simulator attempt?", responseRoute: "native", blocking: "runtime_action" });
    await app.hub.reconcile();
    const request = app.hub.getDashboard(admin).answerNeeded[0];
    assert.ok(request);
    await app.hub.execute(admin, { commandId: "preview-context-answer", type: "request.respond",
      target: { kind: "request", id: request.id },
      expected: { request: request.revision, bindingGeneration: session.bindingGeneration },
      payload: { answer: { kind: "text", text: "Continue the same attempt." } } });
    await drainIdle(app.hub);

    // When either bounded context is loaded, successful delivery must not disappear.
    for (const context of [{ route: "task", id: taskId }, { route: "session", id: session.id }] as const) {
      const snapshot = app.hub.contextSnapshot(admin, context);
      // Then the linked-request projection can show acknowledgment, not unknown.
      assert.equal(snapshot.deliveries?.some((delivery) => delivery["requestId"] === request.id
        && delivery["status"] === "acknowledged"), true);
    }
  } finally { app.close(); }
});
