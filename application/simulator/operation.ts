import type { ZodType } from "zod";
import type { ActionContext, ConnectorError, EffectEvidence, JsonObject, OperationReceipt, PartialEffect, SerializedOperationReceipt } from "../contracts/index.ts";
import { SerializedOperationReceiptSchema } from "../contracts/index.ts";
import type { SimulatorStore } from "./store.ts";

type OperationSpec<T> = {
  readonly connector: "execution" | "runtime";
  readonly kind: string;
  readonly resultSchemaId: string;
  readonly resultSchema: ZodType<T>;
  readonly input: JsonObject;
  readonly effect: () => T;
  readonly evidenceEffect: string;
};

const conflictError = (): ConnectorError => ({ code: "operation_id_payload_conflict", category: "conflict", message: "Operation ID was already used with a different input digest.", retry: "never" });
const failureError = (code = "scripted_failure"): ConnectorError => ({ code, category: "provider_failure", message: "The simulator established a definite provider failure.", retry: "manual_action" });
const unknownError = (): ConnectorError => ({ code: "acknowledgment_lost", category: "timeout", message: "The effect may have occurred; reconcile the same operation ID.", retry: "reconcile_first" });

export function rejected<T>(ctx: ActionContext, kind: string, schemaId: string, error: ConnectorError): OperationReceipt<T> {
  return { operationId: ctx.operationId, operationKind: kind, resultSchemaId: schemaId, updatedAt: "2026-10-22T00:00:00.000Z", partialEffects: [], status: "rejected", error };
}

export function typedReceipt<T>(receipt: SerializedOperationReceipt, resultSchema: ZodType<T>): OperationReceipt<T> {
  const base = { operationId: receipt.operationId, operationKind: receipt.operationKind, resultSchemaId: receipt.resultSchemaId, updatedAt: receipt.updatedAt, partialEffects: receipt.partialEffects, ...(receipt.providerReceiptRef === undefined ? {} : { providerReceiptRef: receipt.providerReceiptRef }) };
  switch (receipt.status) {
    case "accepted": return { ...base, status: "accepted", ...(receipt.progress === undefined ? {} : { progress: receipt.progress }) };
    case "running": return { ...base, status: "running", ...(receipt.progress === undefined ? {} : { progress: receipt.progress }) };
    case "confirmed": return { ...base, status: "confirmed", result: resultSchema.parse(receipt.result), evidence: receipt.evidence };
    case "rejected": return { ...base, status: "rejected", error: receipt.error };
    case "failed": return { ...base, status: "failed", error: receipt.error };
    case "unknown": return { ...base, status: "unknown", error: receipt.error, ...(receipt.reconciliationHint === undefined ? {} : { reconciliationHint: receipt.reconciliationHint }) };
  }
}

function serialize<T>(receipt: OperationReceipt<T>): SerializedOperationReceipt {
  return SerializedOperationReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)));
}

export function executeOperation<T>(store: SimulatorStore, ctx: ActionContext, spec: OperationSpec<T>): OperationReceipt<T> {
  store.recordCall(spec.connector, spec.kind, spec.input, ctx.operationId, ctx.inputDigest);
  const existing = store.getOperation(ctx.operationId);
  if (existing !== undefined) {
    if (existing.digest !== ctx.inputDigest) return rejected(ctx, spec.kind, spec.resultSchemaId, conflictError());
    return typedReceipt(existing.visibleReceipt ?? existing.receipt, spec.resultSchema);
  }

  const accepted: OperationReceipt<T> = { operationId: ctx.operationId, operationKind: spec.kind, resultSchemaId: spec.resultSchemaId, updatedAt: store.now(), partialEffects: [], status: "accepted", progress: "persisted_before_effect" };
  const terminalBase = { operationId: ctx.operationId, operationKind: spec.kind, resultSchemaId: spec.resultSchemaId, partialEffects: [] as readonly PartialEffect[] };
  store.putOperation(ctx.operationId, ctx.inputDigest, serialize(accepted));
  const script = store.takeScript(spec.kind);
  if (script?.kind === "accepted_waiting") {
    const waiting: OperationReceipt<T> = { ...accepted, updatedAt: store.now(), progress: script.progress ?? "waiting" };
    store.putOperation(ctx.operationId, ctx.inputDigest, serialize(waiting));
    return waiting;
  }
  if (script?.kind === "definite_failure") {
    const failed: OperationReceipt<T> = { ...terminalBase, updatedAt: store.now(), status: "failed", error: failureError(script.code) };
    store.putOperation(ctx.operationId, ctx.inputDigest, serialize(failed));
    return failed;
  }
  const result = spec.effect();
  const evidence: EffectEvidence = { effect: spec.evidenceEffect, source: spec.connector === "runtime" ? "runtime_ack" : "provider_receipt", observedAt: store.now() };
  const confirmed: OperationReceipt<T> = { ...terminalBase, updatedAt: store.now(), status: "confirmed", result, evidence };
  if (script?.kind === "partial_release") {
    const partialEffects: readonly PartialEffect[] = [{ description: "Provider retained residual simulated resources.", disposition: "cleanup_pending" }];
    const failed: OperationReceipt<T> = { ...terminalBase, updatedAt: store.now(), partialEffects, status: "failed", error: failureError("partial_release") };
    store.putOperation(ctx.operationId, ctx.inputDigest, serialize(failed));
    return failed;
  }
  if (script?.kind === "unknown_after_effect") {
    const unknown: OperationReceipt<T> = { ...terminalBase, updatedAt: store.now(), status: "unknown", error: unknownError(), reconciliationHint: "Lookup the same client operation ID." };
    store.putOperation(ctx.operationId, ctx.inputDigest, serialize(confirmed), serialize(unknown));
    return unknown;
  }
  store.putOperation(ctx.operationId, ctx.inputDigest, serialize(confirmed));
  return confirmed;
}

export function completeWaitingOperation<T>(
  store: SimulatorStore,
  operationId: string,
  resultSchema: ZodType<T>,
  evidenceEffect: string,
  effect: () => T,
): OperationReceipt<T> {
  const existing = store.getOperation(operationId);
  if (existing === undefined) throw new TypeError("Cannot complete an unknown simulator operation.");
  if (existing.visibleReceipt !== undefined || existing.receipt.status !== "accepted") {
    throw new TypeError("Only an accepted waiting simulator operation can be completed.");
  }
  const result = resultSchema.parse(effect());
  const confirmed: OperationReceipt<T> = {
    operationId: existing.receipt.operationId,
    operationKind: existing.receipt.operationKind,
    resultSchemaId: existing.receipt.resultSchemaId,
    updatedAt: store.now(),
    partialEffects: existing.receipt.partialEffects,
    status: "confirmed",
    result,
    evidence: { effect: evidenceEffect, source: "provider_receipt", observedAt: store.now() },
  };
  store.putOperation(operationId, existing.digest, serialize(confirmed));
  return confirmed;
}
