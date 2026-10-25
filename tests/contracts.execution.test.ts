import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ActionContext, AllocationRequest, CallContext, ExistingEnvironmentRegistration } from "../application/contracts/index.ts";
import { createSimulators } from "../application/simulator/index.ts";

const call = { workspaceId: "workspace", installationId: "sim-execution", correlationId: "corr" } satisfies CallContext;
const action = (operationId: string, inputDigest = `sha256:${operationId}`): ActionContext => ({ ...call, commandId: `cmd-${operationId}`, operationId, inputDigest, authorizedGrantRefs: ["grant"] });
const allocation: AllocationRequest = { taskId: "task", sessionId: "session", attemptId: "attempt", externalProfileRef: "small", parameters: {}, releasePolicyRef: "retain", workAreas: [], allowedPreparationEffects: [] };
const registration: ExistingEnvironmentRegistration = { id: "existing", revision: 1, label: "Existing", executionInstallationId: "sim-execution", locator: {}, secretRefs: [], allowedProjectIds: ["project"], allowedWorkAreas: [], allowRuntimeServiceLaunch: false, weakIdentityExplicitlyAccepted: false };

test("allocation deduplicates the same operation and conflicts on changed input", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  const first = await sims.execution.requestAllocation(action("alloc"), allocation);
  const duplicate = await sims.execution.requestAllocation(action("alloc"), allocation);
  const conflict = await sims.execution.requestAllocation(action("alloc", "sha256:changed"), allocation);
  assert.deepEqual(duplicate, first);
  assert.equal(conflict.status, "rejected");
  assert.equal(sims.calls.list().filter((entry) => entry.operationKind === "execution.requestAllocation").length, 3);
});

test("unknown after effect reconciles from the persisted ledger after reinstantiation", async (t) => {
  const path = join("/tmp", `workhub-restart-${process.pid}-${Date.now()}.sqlite`);
  const first = createSimulators(path);
  first.controls.scriptNext("execution.requestAllocation", { kind: "unknown_after_effect" });
  const response = await first.execution.requestAllocation(action("lost"), allocation);
  assert.equal(response.status, "unknown");
  first.close();

  const restored = createSimulators(path);
  t.after(() => restored.close());
  const lookup = await restored.execution.lookupOperation(call, "lost");
  assert.equal(lookup.kind, "found");
  if (lookup.kind === "found") assert.equal(lookup.receipt.status, "confirmed");
});

test("replacement, stopped targets, weak identity and external activity remain explicit", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-identity-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  sims.controls.setEnvironment("existing", { state: "stopped", assurance: "weak", externalActivity: "active", incarnation: "v1" });
  const probe = await sims.execution.probeExisting(call, registration);
  assert.equal(probe.value.observedState, "stopped");
  assert.equal(probe.value.identity.assurance, "weak");
  assert.equal(probe.value.unmetRequirements.includes("environment_stopped"), true);
  sims.controls.setEnvironment("existing", { state: "running", assurance: "immutable", externalActivity: "active", incarnation: "v2" });
  const inspected = await sims.execution.probeExisting(call, registration);
  assert.equal(inspected.value.identity.native.incarnation, "v2");
});

test("accepted waiting, definite failure and partial release are distinct receipts", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-failures-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  sims.controls.scriptNext("execution.requestAllocation", { kind: "accepted_waiting", progress: "provider_queue" });
  const waiting = await sims.execution.requestAllocation(action("waiting"), allocation);
  assert.equal(waiting.status, "accepted");
  sims.controls.scriptNext("execution.requestAllocation", { kind: "definite_failure", code: "capacity_unavailable" });
  const failed = await sims.execution.requestAllocation(action("failed"), allocation);
  assert.equal(failed.status, "failed");
  const allocated = await sims.execution.requestAllocation(action("partial-allocation"), { ...allocation, attemptId: "partial-release", releasePolicyRef: "delete" });
  assert.equal(allocated.status, "confirmed");
  if (allocated.status !== "confirmed") return;
  sims.controls.scriptNext("execution.releaseAllocation", { kind: "partial_release" });
  const partial = await sims.execution.releaseAllocation(action("release"), { allocationRef: allocated.result.allocationRef, expectedIdentity: allocated.result.identity, lifecycleGrant: allocated.result.lifecycleGrant, releasePolicyRef: allocated.result.lifecycleGrant.releasePolicyRef, controlledWorkTermination: { status: "no_controlled_work" }, preservationDecisionRef: "decision" });
  assert.equal(partial.status, "failed");
  assert.equal(partial.partialEffects[0]?.disposition, "cleanup_pending");
});

test("release exposes retained, stopped and deleted provider outcomes exactly", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-release-results-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  for (const disposition of ["retained", "stopped", "deleted"] as const) {
    const allocated = await sims.execution.requestAllocation(action(`allocate-${disposition}`), { ...allocation, attemptId: `release-${disposition}`, releasePolicyRef: disposition });
    assert.equal(allocated.status, "confirmed");
    if (allocated.status !== "confirmed") return;
    sims.controls.setReleaseResult(allocated.result.allocationRef.id, { disposition, referenceAvailability: disposition === "retained" ? "preserved" : "may_expire" });
    const receipt = await sims.execution.releaseAllocation(action(`release-${disposition}`), { allocationRef: allocated.result.allocationRef, expectedIdentity: allocated.result.identity, lifecycleGrant: allocated.result.lifecycleGrant, releasePolicyRef: allocated.result.lifecycleGrant.releasePolicyRef, controlledWorkTermination: { status: "no_controlled_work" }, preservationDecisionRef: "decision" });
    assert.equal(receipt.status, "confirmed");
    if (receipt.status === "confirmed") assert.equal(receipt.result.disposition, disposition);
  }
});
