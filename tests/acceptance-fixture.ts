import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Actor } from "../application/domain/authorization.ts";
import type { AttemptView, EnvironmentBindingView, SessionView } from "../application/domain/model.ts";
import { Hub, type HubOptions } from "../application/orchestration/hub.ts";

export const admin: Actor = {
  id: "user-admin",
  workspaceId: "workspace-default",
  role: "administrator",
  projectIds: ["project-default"],
  profileIds: ["profile-structured", "profile-limited"],
  bindingIds: [],
};

export const member: Actor = {
  id: "user-member",
  workspaceId: "workspace-default",
  role: "member",
  projectIds: ["project-default"],
  profileIds: ["profile-structured", "profile-limited"],
  bindingIds: [],
};

export const writableArea = {
  key: "provider-volume/project",
  path: "/workspace/project",
  pathNamespace: "provider-guest-posix",
  requestedAccess: "write",
  preparation: "preserve_existing",
} as const;

export const provisionedArea = {
  ...writableArea,
  key: "allocation/project",
  preparation: "provider_profile",
} as const;

export type AcceptanceFixture = {
  readonly root: string;
  readonly path: string;
  readonly hub: Hub;
  close(): void;
};

export function fixture(options: HubOptions = {}): AcceptanceFixture {
  const root = mkdtempSync(join(tmpdir(), "work-hub-acceptance-"));
  const path = join(root, "hub.sqlite");
  const hub = new Hub(path, options);
  return { root, path, hub, close: () => { hub.close(); rmSync(root, { recursive: true }); } };
}

export async function drainIdle(hub: Hub): Promise<void> {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    if (await hub.drain() === 0) return;
  }
  assert.fail("Outbox did not become idle.");
}

export async function createTask(hub: Hub, suffix: string, actor: Actor = member): Promise<string> {
  const receipt = await hub.execute(actor, {
    commandId: `task-${suffix}`,
    type: "task.create",
    payload: { projectId: "project-default", title: `Acceptance ${suffix}`, description: `Description ${suffix}` },
  });
  const id = receipt.objectRefs[0]?.id;
  assert.ok(id);
  return id;
}

export async function delegateNone(hub: Hub, taskId: string, suffix: string): Promise<AttemptView> {
  const receipt = await hub.execute(member, {
    commandId: `delegate-${suffix}`,
    type: "attempt.delegate",
    target: { kind: "task", id: taskId },
    expected: { task: hub.getTask(member, taskId).revision, profile: 1 },
    payload: {
      profileId: "profile-structured",
      environment: { mode: "none" },
      selectedReferenceIds: [],
      selectedResponseIds: [],
      authorizedEffectKinds: [],
    },
  });
  assert.equal(receipt.status, "accepted");
  await drainIdle(hub);
  const id = receipt.objectRefs[0]?.id;
  const attempt = hub.snapshot(member).attempts.find((candidate) => candidate.id === id);
  assert.ok(attempt);
  return attempt;
}

export async function registerReadyEnvironment(
  hub: Hub,
  suffix: string,
  input: { readonly assurance?: "immutable" | "attested" | "weak"; readonly state?: "running" | "stopped" | "missing" | "unknown"; readonly externalActivity?: "idle" | "active" | "unknown"; readonly acceptWeak?: boolean } = {},
): Promise<string> {
  const receipt = await hub.execute(admin, {
    commandId: `register-${suffix}`,
    type: "environment.register",
    payload: {
      label: `Environment ${suffix}`,
      executionInstallationId: "execution-sim",
      locator: { name: `environment-${suffix}` },
      allowedProjectIds: ["project-default"],
      allowedWorkAreas: [writableArea],
      allowRuntimeServiceLaunch: false,
      weakIdentityExplicitlyAccepted: input.acceptWeak ?? false,
    },
  });
  const id = receipt.objectRefs[0]?.id;
  assert.ok(id);
  const simulator = hub.simulator;
  assert.ok(simulator);
  simulator.controls.setEnvironment(id, {
    state: input.state ?? "running",
    assurance: input.assurance ?? "immutable",
    externalActivity: input.externalActivity ?? "idle",
    incarnation: "incarnation-1",
  });
  await hub.execute(admin, {
    commandId: `verify-${suffix}`,
    type: "environment.verify",
    target: { kind: "environment_registration", id },
    expected: { registration: 1 },
    payload: {},
  });
  await drainIdle(hub);
  return id;
}

export async function delegateExisting(hub: Hub, taskId: string, registrationId: string, suffix: string) {
  const registration = hub.getEnvironmentRegistration(admin, registrationId);
  const receipt = await hub.execute(member, {
    commandId: `delegate-existing-${suffix}`,
    type: "attempt.delegate",
    target: { kind: "task", id: taskId },
    expected: { task: hub.getTask(member, taskId).revision, profile: 1, registration: registration.revision },
    payload: {
      profileId: "profile-structured",
      environment: { mode: "existing", registrationId, expectedRegistrationRevision: registration.revision, workAreas: [writableArea], requestedAccess: "write" },
      selectedReferenceIds: [],
      selectedResponseIds: [],
      authorizedEffectKinds: [],
    },
  });
  await drainIdle(hub);
  return receipt;
}

export async function delegateProvisioned(hub: Hub, taskId: string, suffix: string): Promise<{ readonly attempt: AttemptView; readonly session: SessionView; readonly binding: EnvironmentBindingView }> {
  const receipt = await hub.execute(member, {
    commandId: `delegate-provision-${suffix}`,
    type: "attempt.delegate",
    target: { kind: "task", id: taskId },
    expected: { task: hub.getTask(member, taskId).revision, profile: 1 },
    payload: {
      profileId: "profile-structured",
      environment: { mode: "provision", executionInstallationId: "execution-sim", externalProfileRef: "small", parameters: {}, releasePolicyRef: "retain", workAreas: [provisionedArea] },
      selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
    },
  });
  assert.equal(receipt.status, "accepted");
  await drainIdle(hub);
  const attemptId = receipt.objectRefs[0]?.id;
  const snapshot = hub.snapshot(member);
  const attempt = snapshot.attempts.find((item) => item.id === attemptId);
  assert.ok(attempt);
  const session = snapshot.sessions.find((item) => item.id === attempt.sessionId);
  const binding = snapshot.environmentBindings.find((item) => item.attemptId === attempt.id);
  assert.ok(session); assert.ok(binding);
  return { attempt, session, binding };
}

export async function finishAttempt(hub: Hub, attempt: AttemptView, termination: "completed" | "stopped" | "failed" = "completed"): Promise<void> {
  const simulator = hub.simulator;
  assert.ok(simulator);
  const session = hub.getSession(member, attempt.sessionId).session;
  simulator.controls.emitTermination({ hubSessionId: session.id, hubAttemptId: attempt.id, bindingGeneration: session.bindingGeneration, termination });
  await hub.reconcile();
}

export function operationKinds(hub: Hub): readonly string[] {
  const simulator = hub.simulator;
  assert.ok(simulator);
  return simulator.calls.list().map((call) => call.operationKind);
}
