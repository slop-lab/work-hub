import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validatedLookupReceipt } from "../application/orchestration/operation-receipt-validation.ts";
import type { Clock } from "../application/persistence/codec.ts";
import { Store } from "../application/persistence/database.ts";
import { OperationRepository } from "../application/persistence/operation-repository.ts";
import { StateRepository } from "../application/persistence/state-repository.ts";
import { LeaseLostError, withOutboxLease } from "../application/persistence/outbox-lease.ts";

function fixture(): {
  readonly root: string;
  readonly path: string;
  readonly clock: Clock;
  setNow(value: string): void;
} {
  const root = mkdtempSync(join(tmpdir(), "work-hub-durability-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  return {
    root,
    path: join(root, "hub.sqlite"),
    clock: { now: () => now },
    setNow: (value) => { now = new Date(value); },
  };
}

function addJob(repository: OperationRepository): void {
  repository.addOutbox({
    workspaceId: "workspace-default",
    commandId: "command-durable",
    workType: "runtime.sendInstruction",
    connectorKind: "runtime",
    installationId: "runtime-sim-structured",
    stage: "send_instruction",
    payload: { text: "continue" },
    inputDigest: "sha256:test",
  });
}

test("an outbox job is atomically claimed by only one worker", () => {
  // Given
  const fixtureState = fixture();
  const firstStore = new Store(fixtureState.path, fixtureState.clock);
  const secondStore = new Store(fixtureState.path, fixtureState.clock);
  try {
    const first = new OperationRepository(firstStore.database, fixtureState.clock);
    const second = new OperationRepository(secondStore.database, fixtureState.clock);
    addJob(first);

    // When
    const firstClaim = first.claimDue(10);
    const secondClaim = second.claimDue(10);

    // Then
    assert.equal(firstClaim.length, 1);
    assert.equal(secondClaim.length, 0);
  } finally {
    firstStore.close();
    secondStore.close();
    rmSync(fixtureState.root, { recursive: true });
  }
});

test("an expired claimant cannot apply effects or settle after the job is reclaimed", () => {
  // Given
  const fixtureState = fixture();
  const firstStore = new Store(fixtureState.path, fixtureState.clock);
  const secondStore = new Store(fixtureState.path, fixtureState.clock);
  try {
    firstStore.database.exec("CREATE TABLE lease_effects (value TEXT PRIMARY KEY)");
    const first = new OperationRepository(firstStore.database, fixtureState.clock);
    const second = new OperationRepository(secondStore.database, fixtureState.clock);
    addJob(first);
    const stale = first.claimDue(1, 1_000)[0];
    assert.ok(stale);
    fixtureState.setNow("2026-01-01T00:00:02.000Z");
    const current = second.claimDue(1, 1_000)[0];
    assert.ok(current);

    // When
    assert.throws(() => withOutboxLease(stale, () => first.settleConfirmed(stale.id,
      { status: "confirmed" },
      () => firstStore.database.prepare("INSERT INTO lease_effects (value) VALUES ('stale')").run(),
    )), LeaseLostError);
    withOutboxLease(current, () => second.settleConfirmed(current.id,
      { status: "confirmed" },
      () => secondStore.database.prepare("INSERT INTO lease_effects (value) VALUES ('current')").run(),
    ));

    // Then
    const rows = secondStore.database.prepare("SELECT value FROM lease_effects").all();
    assert.deepEqual(rows.map((row) => Reflect.get(row, "value")), ["current"]);
  } finally {
    firstStore.close();
    secondStore.close();
    rmSync(fixtureState.root, { recursive: true });
  }
});

test("lookup effect and outbox settlement roll back together after a crash", () => {
  // Given
  const fixtureState = fixture();
  const store = new Store(fixtureState.path, fixtureState.clock);
  try {
    store.database.exec("CREATE TABLE lookup_effects (value TEXT PRIMARY KEY)");
    const operations = new OperationRepository(store.database, fixtureState.clock);
    addJob(operations);
    const item = operations.claimDue(1)[0];
    assert.ok(item);

    // When
    assert.throws(() => withOutboxLease(item, () => operations.settleConfirmed(item.id,
      { status: "confirmed" },
      () => {
        store.database.prepare("INSERT INTO lookup_effects (value) VALUES ('effect')").run();
        throw new TypeError("simulated crash");
      },
    )), /simulated crash/);

    // Then
    const effectCount = store.database.prepare("SELECT COUNT(*) AS count FROM lookup_effects").get();
    const outbox = store.database.prepare("SELECT state FROM outbox WHERE id = ?").get(item.id);
    assert.equal(Reflect.get(effectCount ?? {}, "count"), 0);
    assert.equal(Reflect.get(outbox ?? {}, "state"), "pending");
  } finally {
    store.close();
    rmSync(fixtureState.root, { recursive: true });
  }
});

test("an inbound event dedupe claim commits atomically with its canonical effect", () => {
  // Given
  const fixtureState = fixture();
  const store = new Store(fixtureState.path, fixtureState.clock);
  try {
    store.database.exec("CREATE TABLE inbound_effects (value TEXT PRIMARY KEY)");
    const state = new StateRepository(store.database, fixtureState.clock);
    const input = {
      workspaceId: "workspace-default",
      installationId: "runtime-sim-structured",
      sourceEventId: "event-1",
      bindingGeneration: 1,
      event: {
        streamScope: "session-1",
        sourceSequence: 1,
        nativeSession: {
          installationId: "runtime-sim-structured",
          providerScope: "simulated",
          kind: "agent-session",
          id: "native-1",
        },
      },
    };
    assert.throws(() => state.claimInboundEvent(input, () => {
      store.database.prepare("INSERT INTO inbound_effects (value) VALUES ('effect')").run();
      throw new TypeError("simulated crash");
    }), /simulated crash/);

    // When
    const applied = state.claimInboundEvent(input, () => {
      store.database.prepare("INSERT INTO inbound_effects (value) VALUES ('effect')").run();
    });
    const replayed = state.claimInboundEvent(input, () => {
      store.database.prepare("INSERT INTO inbound_effects (value) VALUES ('duplicate')").run();
    });

    // Then
    assert.equal(applied, true);
    assert.equal(replayed, false);
    const effects = store.database.prepare("SELECT value FROM inbound_effects").all();
    assert.deepEqual(effects.map((row) => Reflect.get(row, "value")), ["effect"]);
  } finally {
    store.close();
    rmSync(fixtureState.root, { recursive: true });
  }
});

test("lookup rejects a receipt for a different operation id", () => {
  // Given
  const item = {
    id: "outbox-1", leaseToken: "lease-1", workspaceId: "workspace-default",
    operationId: "operation-expected", commandId: "command-1", connectorKind: "runtime" as const,
    installationId: "runtime-sim-structured", inputDigest: "sha256:test",
    operationKind: "runtime.sendInstruction", workType: "operation.lookup", payload: {}, attempts: 1,
  };
  const receipt = { operationId: "operation-other", operationKind: "runtime.sendInstruction",
    resultSchemaId: "workhub.runtime.input-receipt.v1", updatedAt: "2026-01-01T00:00:00.000Z",
    partialEffects: [], status: "rejected", error: { code: "denied", category: "authorization",
      message: "Denied", retry: "never" } };

  // When / Then
  assert.throws(() => validatedLookupReceipt(item, receipt), /does not identify the requested operation/);
});

test("lookup rejects a receipt kind unrelated to the persisted stage", () => {
  // Given
  const item = {
    id: "outbox-1", leaseToken: "lease-1", workspaceId: "workspace-default",
    operationId: "operation-1", commandId: "command-1", connectorKind: "runtime" as const,
    installationId: "runtime-sim-structured", inputDigest: "sha256:test",
    operationKind: "runtime.sendInstruction", workType: "operation.lookup", payload: {}, attempts: 1,
  };
  const receipt = { operationId: "operation-1", operationKind: "runtime.requestStop",
    resultSchemaId: "workhub.runtime.stop-result.v1", updatedAt: "2026-01-01T00:00:00.000Z",
    partialEffects: [], status: "rejected", error: { code: "denied", category: "authorization",
      message: "Denied", retry: "never" } };

  // When / Then
  assert.throws(() => validatedLookupReceipt(item, receipt), /does not identify the requested operation/);
});

test("lookup rejects a delivery receipt for a different response", () => {
  // Given
  const item = {
    id: "outbox-1", leaseToken: "lease-1", workspaceId: "workspace-default",
    operationId: "operation-1", commandId: "command-1", connectorKind: "runtime" as const,
    installationId: "runtime-sim-structured", inputDigest: "sha256:test",
    operationKind: "runtime.deliverResponse", workType: "operation.lookup",
    payload: { responseId: "response-expected" }, attempts: 1,
  };
  const receipt = { operationId: "operation-1", operationKind: "runtime.deliverResponse",
    resultSchemaId: "workhub.runtime.response-receipt.v1", updatedAt: "2026-01-01T00:00:00.000Z",
    partialEffects: [], status: "confirmed", result: { responseId: "response-other" },
    evidence: { effect: "response.acknowledged", source: "provider_receipt",
      observedAt: "2026-01-01T00:00:00.000Z" } };

  // When / Then
  assert.throws(() => validatedLookupReceipt(item, receipt), /different response/);
});

test("lookup rejects a runtime attachment receipt for a different native session", () => {
  // Given
  const item = {
    id: "outbox-1", leaseToken: "lease-1", workspaceId: "workspace-default",
    operationId: "operation-1", commandId: "command-1", connectorKind: "runtime" as const,
    installationId: "runtime-sim-structured", inputDigest: "sha256:test",
    operationKind: "session.attachExisting", workType: "operation.lookup", attempts: 1,
    payload: { sessionId: "session-1", controlMode: "observe",
      nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated",
        kind: "agent-session", id: "native-expected", incarnation: "v1" } },
  };
  const capability = { support: "supported", implementation: "native", limitations: [] };
  const receipt = { operationId: "operation-1", operationKind: "runtime.openSession",
    resultSchemaId: "workhub.runtime.binding.v1", updatedAt: "2026-01-01T00:00:00.000Z",
    partialEffects: [], status: "confirmed", evidence: { effect: "session.opened",
      source: "provider_receipt", observedAt: "2026-01-01T00:00:00.000Z" },
    result: { nativeSession: { installationId: "runtime-sim-structured", providerScope: "simulated",
      kind: "agent-session", id: "native-other", incarnation: "v1" },
      nativeIdentityAssurance: "immutable", origin: "attached_existing",
      route: { id: "external:session-1", ownerInstallationId: "runtime-sim-structured",
        kind: "simulated_external" },
      controlGrant: { id: "control-1", mode: "observe", allowedActions: [],
        externalClientsMayAlsoControl: false },
      capabilities: { servicePreparation: capability, controlTransfer: capability,
        createSession: capability, attachSession: capability, structuredInput: capability,
        structuredOutput: capability, nativeQuestions: capability, requestBridge: capability,
        nativeApprovals: capability, continueNativeSession: capability, outputReplay: capability,
        stableNativeIdentity: capability, resultReporting: capability, activeInputModes: [],
        stopModes: [], stopObservation: "request_only", surfaces: [],
        configurationSchemaId: "runtime-config.v1" }, history: "complete_available" } };

  // When / Then
  assert.throws(() => validatedLookupReceipt(item, receipt), /native attachment target/);
});
