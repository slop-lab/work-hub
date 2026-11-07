import assert from "node:assert/strict";
import test from "node:test";
import { presentState } from "../../application/api/presentation.ts";
import { hubStateSchema } from "../../web/state-schema.ts";
import { admin, fixture, member } from "../acceptance-fixture.ts";

test("attention projection retains explicit project scope for user-directed questions with duplicate task titles", async () => {
  const app = fixture();
  try {
    const projects = [app.hub.administration.projects.create(admin, { name: "Release engineering" }),
      app.hub.administration.projects.create(admin, { name: "Billing platform" })];
    for (const [index, project] of projects.entries()) {
      const created = await app.hub.execute(admin, { commandId: `attention-task-${index}`, type: "task.create",
        payload: { projectId: project.id, title: "Shared delivery task" } });
      const taskId = created.objectRefs.find((reference) => reference.kind === "task")?.id;
      assert.ok(taskId);
      await app.hub.execute(admin, { commandId: `attention-question-${index}`, type: "request.create", payload: {
        kind: "question", projectId: project.id, taskId, recipient: { kind: "user", userId: admin.id },
        prompt: "Which delivery should proceed?", reason: `decision-${index}`, referenceIds: [],
        answerSchema: { kind: "text", minLength: 1, maxLength: 1000 }, blocking: "none",
        validity: { kind: "task", taskId }, responseRoute: "none",
      } });
    }
    const state = hubStateSchema.parse(presentState({ snapshot: app.hub.snapshot(admin), actor: admin, administration: app.hub.administration }));
    assert.deepEqual(state.attention.answerNeeded.map((item) => item.projectId).sort(), projects.map((item) => item.id).sort());
    const restricted = hubStateSchema.parse(presentState({ snapshot: app.hub.snapshot(member), actor: member, administration: app.hub.administration }));
    assert.equal(restricted.attention.answerNeeded.length, 0);
    assert.equal(restricted.projects.some((project) => projects.some((hidden) => hidden.id === project.id)), false);
  } finally { app.close(); }
});
