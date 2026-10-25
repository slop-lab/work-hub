import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validatedLookupReceipt } from "../application/orchestration/operation-receipt-validation.ts";
import { Store } from "../application/persistence/database.ts";
import { OperationRepository } from "../application/persistence/operation-repository.ts";
import { withOutboxLease } from "../application/persistence/outbox-lease.ts";

test("provision lookup validates its allocation instead of parsing a runtime binding", () => {
  // Given
  const allocationRef = { installationId: "execution-sim", providerScope: "simulated",
    kind: "environment", id: "allocation-1", incarnation: "v1" };
  const item = { id: "outbox-1", leaseToken: "lease-1", workspaceId: "workspace-default",
    operationId: "operation-1", commandId: "command-1", connectorKind: "execution" as const,
    installationId: "execution-sim", inputDigest: "sha256:test", operationKind: "delegation.advance",
    workType: "operation.lookup", attempts: 1, payload: { sessionId: "session-1",
      environment: { mode: "provision", releasePolicyRef: "release-policy-1" } } };
  const receipt = { operationId: "operation-1", operationKind: "execution.requestAllocation",
    resultSchemaId: "workhub.execution.allocation.v1", updatedAt: "2026-01-01T00:00:00.000Z",
    partialEffects: [], status: "confirmed", evidence: { effect: "allocation.ready",
      source: "provider_receipt", observedAt: "2026-01-01T00:00:00.000Z" },
    result: { allocationRef, identity: { native: { ...allocationRef, kind: "environment",
      id: "environment-1" }, assurance: "immutable" }, ready: true,
      lifecycleGrant: { id: "lifecycle-1", allocationRef, releasePolicyRef: "release-policy-1",
        allowedActions: ["release_allocation"] } } };

  // When
  const validated = validatedLookupReceipt(item, receipt);

  // Then
  assert.equal(validated.status, "confirmed");
});

test("session attachment lookup accepts a new binding-scoped grant within selected authority", () => {
  // Given
  const identity = { native: { installationId: "execution-sim", providerScope: "simulated",
    kind: "environment", id: "environment-1", incarnation: "v1" }, assurance: "immutable" };
  const item = { id: "outbox-1", leaseToken: "lease-1", workspaceId: "workspace-default",
    operationId: "operation-1", commandId: "command-1", connectorKind: "execution" as const,
    installationId: "execution-sim", inputDigest: "sha256:test",
    operationKind: "session.attachEnvironment", workType: "operation.lookup", attempts: 1,
    targetGeneration: 1, payload: { bindingId: "binding-1", expectedIdentity: identity,
      selectedUseGrantId: "grant-expected", environment: { requestedAccess: "read", workAreas: [] } } };
  const receipt = { operationId: "operation-1", operationKind: "execution.attach",
    resultSchemaId: "workhub.execution.attachment.v1", updatedAt: "2026-01-01T00:00:00.000Z",
    partialEffects: [], status: "confirmed", evidence: { effect: "binding.attached",
      source: "provider_receipt", observedAt: "2026-01-01T00:00:00.000Z" },
    result: { hubBindingId: "binding-1", hubBindingGeneration: 1, identity,
      origin: "registered_existing", attachmentRef: { installationId: "execution-sim",
        providerScope: "simulated", kind: "attachment", id: "attachment-1" }, routes: [],
      useGrant: { id: "grant-other", allowedWorkAreas: [], runtimeServiceLaunch: false,
        enforcement: "enforced", exclusivity: "hub_only", limitations: [] } } };

  // When
  const validated = validatedLookupReceipt(item, receipt);

  // Then
  assert.equal(validated.status, "confirmed");
});

test("repeated read-only failure retries original work and stops after a bound", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "work-hub-lookup-backoff-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const clock = { now: () => now };
  const store = new Store(join(root, "hub.sqlite"), clock);
  try {
    const operations = new OperationRepository(store.database, clock);
    operations.addOutbox({ workspaceId: "workspace-default", commandId: "command-1",
      workType: "execution.probeExisting", connectorKind: "execution",
      installationId: "execution-sim", stage: "probe_existing",
      payload: {}, inputDigest: "sha256:test" });
    const initial = operations.claimDue(1)[0];
    assert.ok(initial);

    // When
    withOutboxLease(initial, () => operations.markOutbox(initial.id, "pending"));
    assert.equal(operations.claimDue(1).length, 0);
    for (let attempt = 2; attempt <= 12; attempt += 1) {
      now = new Date(now.getTime() + 600_000);
      const claimed = operations.claimDue(1)[0];
      assert.ok(claimed);
      assert.equal(claimed.workType, "execution.probeExisting");
      withOutboxLease(claimed, () => operations.markOutbox(claimed.id, "pending"));
    }
    now = new Date(now.getTime() + 86_400_000);

    // Then
    assert.equal(operations.claimDue(1).length, 0);
    const row = store.database.prepare("SELECT next_due_at AS nextDueAt FROM outbox").get();
    assert.match(String(Reflect.get(row ?? {}, "nextDueAt")), /^9999-/);
  } finally {
    store.close();
    rmSync(root, { recursive: true });
  }
});

test("unsupported lookup is delayed instead of spinning immediately", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "work-hub-unsupported-backoff-"));
  const now = new Date("2026-01-01T00:00:00.000Z");
  const clock = { now: () => now };
  const store = new Store(join(root, "hub.sqlite"), clock);
  try {
    const operations = new OperationRepository(store.database, clock);
    operations.addOutbox({ workspaceId: "workspace-default", commandId: "command-1",
      workType: "runtime.sendInstruction", connectorKind: "runtime",
      installationId: "runtime-sim-structured", stage: "send_instruction",
      payload: {}, inputDigest: "sha256:test" });
    const initial = operations.claimDue(1)[0];
    assert.ok(initial);
    withOutboxLease(initial, () => operations.markForLookup(initial.id, { status: "unknown" }));
    const lookup = operations.claimDue(1)[0];
    assert.ok(lookup);

    // When
    withOutboxLease(lookup, () => operations.markOutbox(
      lookup.id, "unknown", { kind: "unsupported" },
    ));

    // Then
    assert.equal(operations.claimDue(1).length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true });
  }
});
