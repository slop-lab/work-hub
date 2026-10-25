import assert from "node:assert/strict";
import test from "node:test";
import { ActionContextSchema, AllocationRequestSchema, ConnectorReceiptDispatchError, OperationSafetySchema, RuntimeEventSchema, validateSerializedOperationReceipt, parseSerializedOperationReceipt } from "../application/contracts/index.ts";

test("closed action context rejects unknown fields", () => {
  assert.equal(ActionContextSchema.safeParse({
    workspaceId: "w", installationId: "i", correlationId: "c", commandId: "cmd", operationId: "op",
    inputDigest: "sha256:one", authorizedGrantRefs: [], privileged: true,
  }).success, false);
});

test("closed allocation request rejects hidden provider fields", () => {
  assert.equal(AllocationRequestSchema.safeParse({
    taskId: "t", sessionId: "s", attemptId: "a", externalProfileRef: "small", parameters: {},
    releasePolicyRef: "retain", workAreas: [], allowedPreparationEffects: [], shell: "rm -rf /",
  }).success, false);
});

test("serialized receipt dispatch rejects an unrecognized status", () => {
  assert.equal(parseSerializedOperationReceipt.bind(undefined, {
    operationId: "op", operationKind: "runtime.startAttempt", resultSchemaId: "input.v1",
    updatedAt: "2026-10-22T00:00:00Z", partialEffects: [], status: "succeeded", result: {},
  }) instanceof Function, true);
  assert.throws(() => parseSerializedOperationReceipt({
    operationId: "op", operationKind: "runtime.startAttempt", resultSchemaId: "input.v1",
    updatedAt: "2026-10-22T00:00:00Z", partialEffects: [], status: "succeeded", result: {},
  }));
});

const confirmedDetachedReceipt = {
  operationId: "detach", operationKind: "execution.detachAttachment",
  resultSchemaId: "workhub.execution.detached.v1", updatedAt: "2026-10-22T00:00:00Z",
  partialEffects: [], status: "confirmed", result: { detached: true },
  evidence: { effect: "binding.detached", source: "provider_receipt", observedAt: "2026-10-22T00:00:00Z" },
} as const;

test("operation receipt dispatch validates a confirmed typed result", () => {
  const receipt = validateSerializedOperationReceipt(confirmedDetachedReceipt);
  assert.equal(receipt.status, "confirmed");
});

test("operation receipt dispatch rejects a mismatched schema id and malformed result", () => {
  assert.throws(
    () => validateSerializedOperationReceipt({ ...confirmedDetachedReceipt, resultSchemaId: "workhub.execution.release.v1" }),
    ConnectorReceiptDispatchError,
  );
  assert.throws(() => validateSerializedOperationReceipt({ ...confirmedDetachedReceipt, result: { detached: false } }));
});

test("runtime event schema is closed at the envelope and payload", () => {
  const event = {
    streamScope: "session", nativeSession: { installationId: "runtime", providerScope: "simulated", kind: "session", id: "native" },
    bindingGeneration: 1, observedAt: "2026-10-22T00:00:00Z",
    payload: { type: "result.submitted", attemptId: "attempt", summary: "done", referenceIds: [], hidden: true },
  };
  assert.equal(RuntimeEventSchema.safeParse(event).success, false);
  assert.equal(RuntimeEventSchema.safeParse({ ...event, payload: { type: "result.submitted", attemptId: "attempt", summary: "done", referenceIds: [] } }).success, true);
});

test("same-id replay safety requires operation-id deduplication", () => {
  assert.equal(OperationSafetySchema.safeParse({ deduplicatesByClientOperationId: false, lookupByClientOperationId: true, replayAfterUnknown: "same_id_only" }).success, false);
  assert.equal(OperationSafetySchema.safeParse({ deduplicatesByClientOperationId: true, lookupByClientOperationId: true, replayAfterUnknown: "same_id_only" }).success, true);
});
