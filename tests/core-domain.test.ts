import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Hub, type Actor } from "../application/orchestration/hub.ts";

const administrator: Actor = {
  id: "user-admin",
  workspaceId: "workspace-default",
  role: "administrator",
  projectIds: ["project-default"],
  profileIds: ["profile-structured", "profile-limited"],
  bindingIds: [],
};

const member: Actor = {
  id: "user-member",
  workspaceId: "workspace-default",
  role: "member",
  projectIds: ["project-default"],
  profileIds: ["profile-structured"],
  bindingIds: [],
};

async function newHub(): Promise<Hub> {
  const directory = await mkdtemp(join(tmpdir(), "work-hub-core-"));
  return new Hub(join(directory, "hub.sqlite"));
}

test("task creation is title-first and command replay is idempotent", async () => {
  // Given
  const hub = await newHub();
  const command = {
    commandId: "cmd-task-1",
    type: "task.create",
    payload: { projectId: "project-default", title: "Trace flaky build" },
  } as const;

  // When
  const first = await hub.execute(member, command);
  const replay = await hub.execute(member, command);

  // Then
  assert.equal(first.status, "confirmed");
  assert.deepEqual(replay, first);
  const taskId = first.objectRefs[0]?.id;
  assert.ok(taskId);
  assert.equal(hub.getTask(member, taskId).title, "Trace flaky build");
  assert.equal(hub.snapshot(member).tasks.length, 1);
  hub.close();
});

test("command id reuse with a different payload is rejected", async () => {
  // Given
  const hub = await newHub();
  await hub.execute(member, {
    commandId: "cmd-reused",
    type: "task.create",
    payload: { projectId: "project-default", title: "First" },
  });

  // When
  const receipt = await hub.execute(member, {
    commandId: "cmd-reused",
    type: "task.create",
    payload: { projectId: "project-default", title: "Changed" },
  });

  // Then
  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.error?.code, "idempotency_key_conflict");
  hub.close();
});

test("task update requires the current expected revision", async () => {
  // Given
  const hub = await newHub();
  const created = await hub.execute(member, {
    commandId: "cmd-create-for-update",
    type: "task.create",
    payload: { projectId: "project-default", title: "Original" },
  });
  const taskId = created.objectRefs[0]?.id;
  assert.ok(taskId);

  // When
  const receipt = await hub.execute(member, {
    commandId: "cmd-stale-update",
    type: "task.update",
    target: { kind: "task", id: taskId },
    expected: { task: 9 },
    payload: { title: "Stale edit" },
  });

  // Then
  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.error?.code, "revision_conflict");
  assert.equal(hub.getTask(member, taskId).title, "Original");
  hub.close();
});

test("one response is committed per request revision", async () => {
  // Given
  const hub = await newHub();
  const request = await hub.execute(member, {
    commandId: "cmd-request",
    type: "request.create",
    payload: {
      kind: "question",
      projectId: "project-default",
      recipient: { kind: "project_members", projectId: "project-default" },
      prompt: "Which branch?",
      referenceIds: [],
      answerSchema: { kind: "single_choice", options: [{ id: "main", label: "main" }] },
      blocking: "none",
      validity: { kind: "project", projectId: "project-default" },
    },
  });
  const requestId = request.objectRefs[0]?.id;
  assert.ok(requestId);

  // When
  const first = await hub.execute(member, {
    commandId: "cmd-answer-first",
    type: "request.respond",
    target: { kind: "request", id: requestId },
    expected: { request: 1 },
    payload: { answer: { kind: "single_choice", optionId: "main" } },
  });
  const second = await hub.execute(administrator, {
    commandId: "cmd-answer-second",
    type: "request.respond",
    target: { kind: "request", id: requestId },
    expected: { request: 1 },
    payload: { answer: { kind: "single_choice", optionId: "main" } },
  });

  // Then
  assert.equal(first.confirmedEffect, "response.persisted");
  assert.equal(second.error?.code, "request_not_open");
  assert.equal(hub.getRequest(member, requestId).status, "answered");
  hub.close();
});

test("members cannot administer environment registrations", async () => {
  // Given
  const hub = await newHub();

  // When
  const receipt = await hub.execute(member, {
    commandId: "cmd-register-denied",
    type: "environment.register",
    payload: {
      label: "shared-dev",
      executionInstallationId: "execution-sim",
      locator: { name: "shared-dev" },
      allowedProjectIds: ["project-default"],
      allowedWorkAreas: [],
      allowRuntimeServiceLaunch: false,
    },
  });

  // Then
  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.error?.code, "forbidden");
  hub.close();
});
