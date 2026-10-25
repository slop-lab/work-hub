import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ActionContext, AllocationDescriptor, AllocationRelease, AllocationRequest, AttachmentRequest, CallContext, ExistingEnvironmentRegistration, JsonObject, ResourceIdentity } from "../application/contracts/index.ts";
import { createSimulators } from "../application/simulator/index.ts";
import type { Simulators } from "../application/simulator/index.ts";

const call = { workspaceId: "workspace", installationId: "sim-execution", correlationId: "identity-contract" } satisfies CallContext;
const action = (operationId: string): ActionContext => ({ ...call, commandId: `command:${operationId}`, operationId, inputDigest: `sha256:${operationId}`, authorizedGrantRefs: ["grant"] });
const registration = (id: string, label: string, locator: JsonObject): ExistingEnvironmentRegistration => ({ id, revision: 1, label, executionInstallationId: call.installationId, locator, secretRefs: [], allowedProjectIds: ["project"], allowedWorkAreas: [], allowRuntimeServiceLaunch: false, weakIdentityExplicitlyAccepted: false });
const aliasA = registration("registration-a", "Primary label", { region: "test", target: { namespace: "team", name: "shared" } });
const aliasB = registration("registration-b", "Renamed alias", { target: { name: "shared", namespace: "team" }, region: "test" });
const different = registration("registration-c", "Different target", { region: "test", target: { namespace: "team", name: "other" } });
const fixture = (t: TestContext): Simulators => {
  const directory = mkdtempSync(join(tmpdir(), "workhub-identity-"));
  const sims = createSimulators(join(directory, "fixture.sqlite"));
  t.after(() => {
    sims.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return sims;
};
const attachmentRequest = (expectedIdentity: ResourceIdentity, hubBindingId = "binding"): AttachmentRequest => ({ hubBindingId, hubBindingGeneration: 1, projectId: "project", taskId: "task", sessionId: "session", target: { kind: "registered_existing", registration: aliasA, expectedIdentity }, workAreas: [], requestedAccess: "write", preparation: "preserve_existing" });
const allocationRequest = (attemptId: string, releasePolicyRef = "retain"): AllocationRequest => ({ taskId: "task", sessionId: "session", attemptId, externalProfileRef: "small", parameters: {}, releasePolicyRef, workAreas: [], allowedPreparationEffects: [] });
const releaseInput = (allocation: AllocationDescriptor): AllocationRelease => ({ allocationRef: allocation.allocationRef, expectedIdentity: allocation.identity, lifecycleGrant: allocation.lifecycleGrant, releasePolicyRef: allocation.lifecycleGrant.releasePolicyRef, controlledWorkTermination: { status: "no_controlled_work" }, preservationDecisionRef: "decision" });

test("existing registration aliases resolve to provider identity while different locators remain distinct", async (t) => {
  // Given: two registration rows describe one provider target and a third describes another target.
  const sims = fixture(t);

  // When: each registration is resolved through the public execution connector.
  const [first, second, third] = await Promise.all([
    sims.execution.probeExisting(call, aliasA),
    sims.execution.probeExisting(call, aliasB),
    sims.execution.probeExisting(call, different),
  ]);

  // Then: registration metadata does not split one provider resource, while a different locator does.
  assert.deepEqual(second.value.identity, first.value.identity);
  assert.notEqual(third.value.identity.native.id, first.value.identity.native.id);
});

test("registration-scoped controls replace the shared provider incarnation across aliases", async (t) => {
  // Given: both aliases have been resolved and one is attached to the shared provider target.
  const sims = fixture(t);
  const firstProbe = await sims.execution.probeExisting(call, aliasA);
  await sims.execution.probeExisting(call, aliasB);
  const attached = await sims.execution.attach(action("attach-alias"), attachmentRequest(firstProbe.value.identity));
  assert.equal(attached.status, "confirmed");
  if (attached.status !== "confirmed") return;

  // When: the compatible registration-ID control reports a replacement through the other alias.
  sims.controls.setEnvironment(aliasB.id, { state: "running", assurance: "immutable", externalActivity: "idle", incarnation: "v2" });
  const observed = await sims.execution.inspectBinding(call, attached.result);

  // Then: the original alias observes the replacement of the same provider resource.
  assert.equal(observed.value.identity.native.id, firstProbe.value.identity.native.id);
  assert.equal(observed.value.identity.native.incarnation, "v2");
  assert.equal(observed.value.attachmentValid, false);
  assert.deepEqual(observed.value.limitations, ["identity_replaced"]);
});

test("new allocations retain independent provider identities and lifecycle grants", async (t) => {
  // Given: two allocation requests differ only in their attempt-owned reference.
  const sims = fixture(t);

  // When: the provider grants both allocations.
  const [first, second] = await Promise.all([
    sims.execution.requestAllocation(action("allocate-a"), allocationRequest("attempt-a")),
    sims.execution.requestAllocation(action("allocate-b"), allocationRequest("attempt-b")),
  ]);

  // Then: canonicalizing existing locators does not merge newly allocated resources or grants.
  assert.equal(first.status, "confirmed");
  assert.equal(second.status, "confirmed");
  if (first.status !== "confirmed" || second.status !== "confirmed") return;
  assert.notEqual(second.result.identity.native.id, first.result.identity.native.id);
  assert.notEqual(second.result.lifecycleGrant.id, first.result.lifecycleGrant.id);
});

test("attachment rejects every mismatched resource identity field", async (t) => {
  // Given: a verified provider identity and mutations of every associated identity field.
  const sims = fixture(t);
  const identity = (await sims.execution.probeExisting(call, aliasA)).value.identity;
  const mismatches = [
    { name: "installation", value: { ...identity, native: { ...identity.native, installationId: "other-installation" } } },
    { name: "provider scope", value: { ...identity, native: { ...identity.native, providerScope: "other-scope" } } },
    { name: "kind", value: { ...identity, native: { ...identity.native, kind: "other-kind" } } },
    { name: "provider id", value: { ...identity, native: { ...identity.native, id: "other-id" } } },
    { name: "incarnation", value: { ...identity, native: { ...identity.native, incarnation: "v2" } } },
    { name: "assurance", value: { ...identity, assurance: "attested" as const } },
    { name: "continuity token", value: { ...identity, continuityToken: "other-token" } },
  ] satisfies readonly { readonly name: string; readonly value: ResourceIdentity }[];

  for (const mismatch of mismatches) {
    await t.test(mismatch.name, async () => {
      // When: attachment is attempted with one mismatched identity field.
      const receipt = await sims.execution.attach(action(`wrong-${mismatch.name.replaceAll(" ", "-")}`), attachmentRequest(mismatch.value, `binding-${mismatch.name}`));

      // Then: the connector refuses the association before creating attachment access.
      assert.equal(receipt.status, "rejected");
      if (receipt.status === "rejected") assert.equal(receipt.error.category, "identity_mismatch");
    });
  }
});

test("detachment rejects an attachment reference that is not associated with the binding", async (t) => {
  // Given: an active attachment to a verified environment.
  const sims = fixture(t);
  const identity = (await sims.execution.probeExisting(call, aliasA)).value.identity;
  const attached = await sims.execution.attach(action("attach-reference"), attachmentRequest(identity));
  assert.equal(attached.status, "confirmed");
  if (attached.status !== "confirmed") return;

  // When: detachment names a different native attachment reference.
  const detached = await sims.execution.detachAttachment(action("detach-wrong-reference"), { attachmentRef: { ...attached.result.attachmentRef, id: "attachment:other" }, expectedIdentity: identity });

  // Then: access remains active because the supplied reference was not associated with it.
  assert.equal(detached.status, "rejected");
  const observed = await sims.execution.inspectBinding(call, attached.result);
  assert.equal(observed.value.attachmentValid, true);
});

test("detachment ends attachment access without changing the environment", async (t) => {
  // Given: an active attachment to a running existing environment.
  const sims = fixture(t);
  const identity = (await sims.execution.probeExisting(call, aliasA)).value.identity;
  const attached = await sims.execution.attach(action("attach-detach"), attachmentRequest(identity));
  assert.equal(attached.status, "confirmed");
  if (attached.status !== "confirmed") return;

  // When: the exact attachment and resource identity are detached.
  const detached = await sims.execution.detachAttachment(action("detach-associated"), { attachmentRef: attached.result.attachmentRef, expectedIdentity: attached.result.identity });
  assert.equal(detached.status, "confirmed");
  const observed = await sims.execution.inspectBinding(call, attached.result);

  // Then: attachment access is invalid, while the provider environment remains running and unchanged.
  assert.equal(observed.value.attachmentValid, false);
  assert.equal(observed.value.grantValid, false);
  assert.equal(observed.value.state, "running");
  assert.deepEqual(observed.value.identity, identity);
  assert.deepEqual(observed.value.limitations, ["attachment_detached"]);
});

test("allocation release rejects swapped and fabricated lifecycle authority", async (t) => {
  // Given: two independently issued allocations and lifecycle grants.
  const sims = fixture(t);
  const first = await sims.execution.requestAllocation(action("release-auth-a"), allocationRequest("release-auth-a", "retain-a"));
  const second = await sims.execution.requestAllocation(action("release-auth-b"), allocationRequest("release-auth-b", "retain-b"));
  assert.equal(first.status, "confirmed");
  assert.equal(second.status, "confirmed");
  if (first.status !== "confirmed" || second.status !== "confirmed") return;
  const valid = releaseInput(first.result);
  const mismatches = [
    { name: "allocation", input: { ...valid, allocationRef: second.result.allocationRef } },
    { name: "grant", input: { ...valid, lifecycleGrant: second.result.lifecycleGrant } },
    { name: "policy", input: { ...valid, releasePolicyRef: "different-policy" } },
    { name: "identity", input: { ...valid, expectedIdentity: second.result.identity } },
    { name: "fabricated grant", input: { ...valid, lifecycleGrant: { ...valid.lifecycleGrant, id: "fabricated-grant" } } },
  ] satisfies readonly { readonly name: string; readonly input: AllocationRelease }[];

  for (const mismatch of mismatches) {
    await t.test(mismatch.name, async () => {
      // When: release combines authority that was not issued for this exact allocation.
      const receipt = await sims.execution.releaseAllocation(action(`release-wrong-${mismatch.name.replaceAll(" ", "-")}`), mismatch.input);

      // Then: provider-side authorization rejects the release.
      assert.equal(receipt.status, "rejected");
    });
  }
});

test("allocation release keeps default grants unexpired and rejects explicit expired or existing-resource authority", async (t) => {
  // Given: a default issued grant without expiry and an explicitly expired supplied variant.
  const sims = fixture(t);
  const allocated = await sims.execution.requestAllocation(action("release-expiring"), allocationRequest("release-expiring", "retain-expired"));
  assert.equal(allocated.status, "confirmed");
  if (allocated.status !== "confirmed") return;
  assert.equal(allocated.result.lifecycleGrant.expiresAt, undefined);
  const valid = releaseInput(allocated.result);

  // When: an explicitly expired grant and a fabricated grant for an existing target are used.
  const expired = await sims.execution.releaseAllocation(action("release-expired"), { ...valid, lifecycleGrant: { ...valid.lifecycleGrant, expiresAt: "2026-10-21T00:00:00.000Z" } });
  const existingIdentity = (await sims.execution.probeExisting(call, aliasA)).value.identity;
  const fabricated = await sims.execution.releaseAllocation(action("release-existing"), {
    allocationRef: existingIdentity.native,
    expectedIdentity: existingIdentity,
    lifecycleGrant: { id: "fabricated-existing-grant", allocationRef: existingIdentity.native, releasePolicyRef: "delete", allowedActions: ["release_allocation"] },
    releasePolicyRef: "delete",
    controlledWorkTermination: { status: "no_controlled_work" },
    preservationDecisionRef: "decision",
  });

  // Then: neither expired nor attach-only authority can release provider resources.
  assert.equal(expired.status, "rejected");
  if (expired.status === "rejected") assert.equal(expired.error.code, "lifecycle_grant_expired");
  assert.equal(fabricated.status, "rejected");
});

test("release outcomes agree with later binding inspection", async (t) => {
  // Given: retained, stopped, and deleted allocations with active attachments.
  const sims = fixture(t);
  const cases = [
    { disposition: "retained", referenceAvailability: "preserved", state: "running" },
    { disposition: "stopped", referenceAvailability: "may_expire", state: "stopped" },
    { disposition: "deleted", referenceAvailability: "may_expire", state: "missing" },
  ] as const;

  for (const expected of cases) {
    await t.test(expected.disposition, async () => {
      const allocated = await sims.execution.requestAllocation(action(`outcome-allocate-${expected.disposition}`), allocationRequest(`outcome-${expected.disposition}`, expected.disposition));
      assert.equal(allocated.status, "confirmed");
      if (allocated.status !== "confirmed") return;
      const attached = await sims.execution.attach(action(`outcome-attach-${expected.disposition}`), { hubBindingId: `outcome-${expected.disposition}`, hubBindingGeneration: 1, projectId: "project", taskId: "task", sessionId: "session", target: { kind: "allocation", allocationRef: allocated.result.allocationRef, expectedIdentity: allocated.result.identity, lifecycleGrant: allocated.result.lifecycleGrant }, workAreas: [], requestedAccess: "write", preparation: "preserve_existing" });
      assert.equal(attached.status, "confirmed");
      if (attached.status !== "confirmed") return;
      sims.controls.setReleaseResult(allocated.result.allocationRef.id, { disposition: expected.disposition, referenceAvailability: expected.referenceAvailability });

      // When: the exact issued lifecycle authority applies its configured provider outcome.
      const released = await sims.execution.releaseAllocation(action(`outcome-release-${expected.disposition}`), releaseInput(allocated.result));
      const observed = await sims.execution.inspectBinding(call, attached.result);

      // Then: the receipt and subsequent provider observation describe the same outcome.
      assert.equal(released.status, "confirmed");
      if (released.status === "confirmed") assert.deepEqual(released.result, { disposition: expected.disposition, referenceAvailability: expected.referenceAvailability });
      assert.equal(observed.value.state, expected.state);
    });
  }
});
