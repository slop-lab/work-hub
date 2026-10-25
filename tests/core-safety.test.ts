import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Hub, type Actor } from "../application/orchestration/hub.ts";
import { Store } from "../application/persistence/database.ts";
import { OperationRepository } from "../application/persistence/operation-repository.ts";
import { StateRepository } from "../application/persistence/state-repository.ts";
import { verifiedExistingTarget } from "../application/orchestration/environment-safety.ts";
import { NativeRefSchema } from "../application/contracts/index.ts";

const member: Actor = {
  id: "user-member", workspaceId: "workspace-default", role: "member",
  projectIds: ["project-default"], profileIds: ["profile-structured"], bindingIds: [],
};

async function fixture(): Promise<Hub> {
  const directory = await mkdtemp(join(tmpdir(), "work-hub-safety-"));
  return new Hub(join(directory, "hub.sqlite"));
}

async function runningAttempt(hub: Hub) {
  const created = await hub.execute(member, {
    commandId: "safety-task", type: "task.create",
    payload: { projectId: "project-default", title: "Safety task" },
  });
  const taskId = created.objectRefs[0]?.id;
  assert.ok(taskId);
  const delegated = await hub.execute(member, {
    commandId: "safety-delegate", type: "attempt.delegate",
    target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
    payload: { profileId: "profile-structured", environment: { mode: "none" },
      selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] },
  });
  for (let index = 0; index < 4; index += 1) await hub.drain();
  const attemptId = delegated.objectRefs[0]?.id;
  assert.ok(attemptId);
  const attempt = hub.snapshot(member).attempts.find((item) => item.id === attemptId);
  assert.ok(attempt);
  return attempt;
}

test("nested store transactions use savepoints", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "work-hub-transaction-"));
  const store = new Store(join(directory, "hub.sqlite"));

  // When
  const value = store.transaction(() => store.transaction(() => 42));

  // Then
  assert.equal(value, 42);
  store.close();
});

test("instruction rejects a stale binding generation before creating an outbox operation", async () => {
  // Given
  const hub = await fixture();
  const attempt = await runningAttempt(hub);

  // When
  const receipt = await hub.execute(member, {
    commandId: "safety-stale-instruction", type: "session.instruct",
    target: { kind: "session", id: attempt.sessionId },
    expected: { bindingGeneration: 999 },
    payload: { attemptId: attempt.id, text: "stale", referenceIds: [], mode: "immediate" },
  });

  // Then
  assert.equal(receipt.error?.code, "binding_generation_conflict");
  assert.equal(hub.snapshot(member).operations?.filter((item) => item["commandId"] === "safety-stale-instruction").length, 0);
  hub.close();
});

test("bridge acknowledgment is scoped to the credential session", async () => {
  // Given
  const hub = await fixture();
  const attempt = await runningAttempt(hub);
  const session = hub.getSession(member, attempt.sessionId);
  const nativeSession = NativeRefSchema.parse(JSON.parse(session.session.nativeIdentityKey ?? "null"));
  const request = await hub.execute(member, {
    commandId: "safety-request", type: "request.create",
    payload: {
      kind: "question", projectId: "project-default", taskId: attempt.taskId,
      sessionId: attempt.sessionId, attemptId: attempt.id, bindingGeneration: 1,
      recipient: { kind: "project_members", projectId: "project-default" },
      prompt: "Proceed?", referenceIds: [],
      answerSchema: { kind: "text", minLength: 1, maxLength: 20 },
      blocking: "runtime_action",
      validity: { kind: "attempt", target: {
        hubSessionId: attempt.sessionId, nativeSession, bindingGeneration: 1,
        controlGrantRef: `control:${attempt.sessionId}`, hubAttemptId: attempt.id,
      } }, responseRoute: "bridge",
    },
  });
  const requestId = request.objectRefs[0]?.id;
  assert.ok(requestId);
  const response = await hub.execute(member, {
    commandId: "safety-response", type: "request.respond",
    target: { kind: "request", id: requestId }, expected: { request: 1, bindingGeneration: 1 },
    payload: { answer: { kind: "text", text: "yes" } },
  });
  const responseId = response.objectRefs[0]?.id;
  assert.ok(responseId);
  const polled = hub.bridgeResponses({
    id: "runtime-a", workspaceId: "workspace-default", role: "runtime",
    projectIds: ["project-default"], profileIds: [], bindingIds: [],
    sessionId: attempt.sessionId, attemptId: attempt.id, bindingGeneration: 1,
  });
  const responseDigest = polled.items[0]?.["responseDigest"];
  if (typeof responseDigest !== "string") throw new TypeError("Expected bridge response digest.");

  // When
  const receipt = await hub.execute({
    id: "runtime-b", workspaceId: "workspace-default", role: "runtime",
    projectIds: ["project-default"], profileIds: [], bindingIds: [],
    sessionId: "session-b", attemptId: "attempt-b", bindingGeneration: 1,
    allowedCommandTypes: ["bridge.response.ack"],
  }, {
    commandId: "safety-wrong-ack", type: "bridge.response.ack",
    payload: { responseId, responseDigest, bindingGeneration: 1 },
  });

  // Then
  assert.equal(receipt.error?.code, "bridge_scope_mismatch");
  hub.close();
});

test("task stop decision fences preparation before any runtime side effect", async () => {
  // Given
  const hub = await fixture();
  const created = await hub.execute(member, {
    commandId: "safety-stop-task", type: "task.create",
    payload: { projectId: "project-default", title: "Stop before start" },
  });
  const taskId = created.objectRefs[0]?.id;
  assert.ok(taskId);
  await hub.execute(member, {
    commandId: "safety-stop-delegate", type: "attempt.delegate",
    target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
    payload: { profileId: "profile-structured", environment: { mode: "none" },
      selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [] },
  });

  // When
  const receipt = await hub.execute(member, {
    commandId: "safety-stop-status", type: "task.setStatus",
    target: { kind: "task", id: taskId }, expected: { task: 2 },
    payload: { status: "canceled", activeExecutionDecision: "request_stop" },
  });
  for (let index = 0; index < 3; index += 1) await hub.drain();

  // Then
  assert.equal(receipt.operationIds.length, 1);
  assert.deepEqual(hub.simulator?.calls.list(), []);
  hub.close();
});

test("operation rejection remains rejected when its outbox work is terminal", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "work-hub-operation-status-"));
  const store = new Store(join(directory, "hub.sqlite"));
  const operations = new OperationRepository(store.database, store.clock);
  const operationId = operations.addOutbox({
    workspaceId: "workspace-default", commandId: "status-command", workType: "runtime.sendInstruction",
    connectorKind: "runtime", installationId: "runtime-sim-structured", stage: "send_instruction",
    targetId: "attempt-x", payload: {}, inputDigest: "sha256:test",
  });
  const item = operations.due(1)[0];
  assert.ok(item);

  // When
  operations.markOutbox(item.id, "done", { status: "rejected", code: "denied" });

  // Then
  const row = store.database.prepare("SELECT status FROM external_operations WHERE id = ?")
    .get(operationId);
  assert.equal(Reflect.get(row ?? {}, "status"), "rejected");
  store.close();
});

test("older runtime source sequence is rejected before event mutation", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "work-hub-event-order-"));
  const store = new Store(join(directory, "hub.sqlite"));
  const state = new StateRepository(store.database, store.clock);
  const base = {
    workspaceId: "workspace-default", installationId: "runtime-sim-structured",
    bindingGeneration: 1,
  };
  const event = (sourceSequence: number) => ({
    streamScope: "session-a", sourceSequence,
    nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated",
      kind: "agent-session", id: "native-a", incarnation: "v1" },
    bindingGeneration: 1, observedAt: "2026-10-25T00:00:00.000Z",
    payload: { type: "extension", namespace: "test", data: {} },
  });
  assert.equal(state.claimInboundEvent({ ...base, sourceEventId: "event-2", event: event(2) }), true);

  // When
  const accepted = state.claimInboundEvent({ ...base, sourceEventId: "event-1", event: event(1) });

  // Then
  assert.equal(accepted, false);
  store.close();
});

test("existing environment selection rejects grant paths outside registration", () => {
  // Given
  const identity = { native: { installationId: "execution-sim", providerScope: "simulated",
    kind: "container", id: "environment-a", incarnation: "v1" }, assurance: "immutable" as const };
  const registeredArea = { key: "repo", path: "/repo", pathNamespace: "guest",
    requestedAccess: "read" as const, preparation: "preserve_existing" as const };

  // When
  const accepted = verifiedExistingTarget({
    registration: { id: "registration-a", revision: 1, label: "A", executionInstallationId: "execution-sim",
      locator: {}, secretRefs: [], allowedProjectIds: ["project-default"], allowedWorkAreas: [registeredArea],
      allowRuntimeServiceLaunch: false, verifiedIdentity: identity,
      verifiedAt: "2026-10-25T00:00:00.000Z", weakIdentityExplicitlyAccepted: false },
    priorIdentity: identity,
    probe: { identity, observedState: "running", availableWorkAreas: [registeredArea], routeKinds: [],
      unmetRequirements: [], availableUseGrant: { id: "grant-a", allowedWorkAreas: [registeredArea],
        runtimeServiceLaunch: false, enforcement: "enforced", exclusivity: "hub_only", limitations: [] } },
    selection: { mode: "existing", registrationId: "registration-a", expectedRegistrationRevision: 1,
      requestedAccess: "write", workAreas: [{ ...registeredArea, key: "etc", path: "/etc",
        requestedAccess: "write" }] },
    now: "2026-10-25T00:00:00.000Z",
  });

  // Then
  assert.equal(accepted, false);
});
