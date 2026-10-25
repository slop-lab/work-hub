import { z } from "zod";

import {
  AllocationDescriptorSchema, EnvironmentAttachmentSchema, NativeRefSchema, ResourceIdentitySchema,
  RuntimeBindingDescriptorSchema, WorkAreaSchema,
  type JsonValue, type OperationReceipt, type SerializedOperationReceipt,
  validateSerializedOperationReceipt,
} from "../contracts/index.ts";
import { assertNever } from "../domain/assert-never.ts";
import type { OutboxItem } from "../persistence/operation-repository.ts";
import { actionContext } from "./context.ts";
import { validateConnectorReceipt } from "./connector-receipt.ts";
import { attachmentHonorsSelection, sameResourceIdentity } from "./environment-safety.ts";

export function validatedLookupReceipt(item: OutboxItem, value: unknown): SerializedOperationReceipt {
  if (item.operationId === undefined) throw new TypeError("Lookup job has no original operation ID.");
  const expectedKind = connectorOperationKind(item);
  const parsed = validateSerializedOperationReceipt(value);
  validateConnectorReceipt({
    context: actionContext(item), operationKind: expectedKind, receipt: operationReceipt(parsed),
  });
  if (parsed.status === "confirmed") {
    validateConfirmedAssociation(item, parsed.result, parsed.updatedAt);
  }
  return parsed;
}

function operationReceipt(receipt: SerializedOperationReceipt): OperationReceipt<JsonValue> {
  const base = {
    operationId: receipt.operationId, operationKind: receipt.operationKind,
    resultSchemaId: receipt.resultSchemaId, updatedAt: receipt.updatedAt,
    partialEffects: receipt.partialEffects.map((effect) => ({
      description: effect.description, disposition: effect.disposition,
      ...(effect.resource === undefined ? {} : { resource: effect.resource }),
    })),
    ...(receipt.providerReceiptRef === undefined ? {} : {
      providerReceiptRef: receipt.providerReceiptRef,
    }),
  };
  switch (receipt.status) {
    case "accepted":
    case "running":
      return { ...base, status: receipt.status,
        ...(receipt.progress === undefined ? {} : { progress: receipt.progress }) };
    case "confirmed":
      return { ...base, status: "confirmed", result: receipt.result, evidence: receipt.evidence };
    case "rejected":
    case "failed":
      return { ...base, status: receipt.status, error: receipt.error };
    case "unknown":
      return { ...base, status: "unknown", error: receipt.error,
        ...(receipt.reconciliationHint === undefined ? {} : {
          reconciliationHint: receipt.reconciliationHint,
        }) };
    default: return assertNever(receipt);
  }
}

function validateConfirmedAssociation(item: OutboxItem, result: unknown, observedAt: string): void {
  switch (item.operationKind) {
    case "runtime.deliverResponse": {
      const expected = z.strictObject({ responseId: z.string() }).passthrough().parse(item.payload);
      const actual = z.strictObject({ responseId: z.string() }).passthrough().parse(result);
      if (actual.responseId !== expected.responseId) {
        throw new TypeError("Delivery lookup receipt acknowledges a different response.");
      }
      return;
    }
    case "execution.attachForDelegation":
      validateDelegationAttachment(item, result, observedAt);
      return;
    case "session.attachEnvironment":
      validateSessionAttachment(item, result, observedAt);
      return;
    case "session.attachExisting":
      validateNativeAttachment(item, result);
      return;
    case "runtime.openForDelegation":
      validateDelegationRuntime(item, result);
      return;
    case "delegation.advance":
      validateDelegationAdvance(item, result);
      return;
    default:
      return;
  }
}

function validateDelegationAttachment(item: OutboxItem, result: unknown, observedAt: string): void {
  const payload = z.strictObject({
    delegation: z.strictObject({ bindingId: z.string(), environment: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("existing"), requestedAccess: z.union([
        z.literal("read"), z.literal("write"),
      ]), workAreas: z.array(WorkAreaSchema) }).passthrough(),
      z.strictObject({ mode: z.literal("provision"), workAreas: z.array(WorkAreaSchema) }).passthrough(),
    ]) }).passthrough(),
    target: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("registered_existing"), expectedIdentity: ResourceIdentitySchema })
        .passthrough(),
      z.strictObject({ kind: z.literal("allocation"), expectedIdentity: ResourceIdentitySchema,
        lifecycleGrant: z.strictObject({ id: z.string() }).passthrough() }).passthrough(),
    ]),
    authorizedGrantRefs: z.array(z.string()),
  }).parse(item.payload);
  const attachment = EnvironmentAttachmentSchema.parse(result);
  const requestedAccess = payload.delegation.environment.mode === "existing"
    ? payload.delegation.environment.requestedAccess
    : payload.delegation.environment.workAreas.some((area) => area.requestedAccess === "write")
      ? "write" : "read";
  const grantAssociationValid = payload.target.kind === "registered_existing"
    ? payload.authorizedGrantRefs.length === 1
    : attachment.lifecycleGrant?.id === payload.target.lifecycleGrant.id &&
      payload.authorizedGrantRefs.length === 1 &&
      payload.authorizedGrantRefs[0] === payload.target.lifecycleGrant.id;
  if (attachment.hubBindingId !== payload.delegation.bindingId ||
    attachment.hubBindingGeneration !== (item.targetGeneration ?? 1) ||
    attachment.origin !== (payload.target.kind === "allocation" ? "allocated" : "registered_existing") ||
    attachment.attachmentRef.installationId !== item.installationId ||
    attachment.routes.some((route) => route.ownerInstallationId !== item.installationId) ||
    !sameResourceIdentity(attachment.identity, payload.target.expectedIdentity) ||
    !grantAssociationValid ||
    !attachmentHonorsSelection({ attachment, expectedIdentity: payload.target.expectedIdentity,
      requestedAccess, workAreas: payload.delegation.environment.workAreas,
      now: observedAt })) {
    throw new TypeError("Attachment lookup receipt does not match the persisted target and grant.");
  }
}

function validateSessionAttachment(item: OutboxItem, result: unknown, observedAt: string): void {
  const payload = z.strictObject({ bindingId: z.string(), environment: z.strictObject({
    requestedAccess: z.union([z.literal("read"), z.literal("write")]),
    workAreas: z.array(WorkAreaSchema),
  }).passthrough(), expectedIdentity: ResourceIdentitySchema,
    selectedUseGrantId: z.string() }).passthrough().parse(item.payload);
  const attachment = EnvironmentAttachmentSchema.parse(result);
  if (attachment.hubBindingId !== payload.bindingId ||
    attachment.hubBindingGeneration !== (item.targetGeneration ?? 1) ||
    attachment.origin !== "registered_existing" ||
    attachment.attachmentRef.installationId !== item.installationId ||
    attachment.routes.some((route) => route.ownerInstallationId !== item.installationId) ||
    !attachmentHonorsSelection({ attachment, expectedIdentity: payload.expectedIdentity,
      requestedAccess: payload.environment.requestedAccess, workAreas: payload.environment.workAreas,
      now: observedAt })) {
    throw new TypeError("Session attachment lookup receipt does not match the persisted target and grant.");
  }
}

function validateNativeAttachment(item: OutboxItem, result: unknown): void {
  const payload = z.strictObject({ sessionId: z.string(), nativeSession: NativeRefSchema,
    controlMode: z.union([z.literal("observe"), z.literal("control")]),
    route: z.strictObject({ id: z.string(), ownerInstallationId: z.string(), kind: z.string(),
      expiresAt: z.string().optional() }).optional() }).passthrough().parse(item.payload);
  const descriptor = RuntimeBindingDescriptorSchema.parse(result);
  const expectedRoute = payload.route ?? {
    id: `external:${payload.sessionId}`, ownerInstallationId: item.installationId,
    kind: "simulated_external",
  };
  if (!sameNativeRef(payload.nativeSession, descriptor.nativeSession) ||
    descriptor.origin !== "attached_existing" || descriptor.controlGrant.mode !== payload.controlMode ||
    (payload.controlMode === "observe" && descriptor.controlGrant.allowedActions.length > 0) ||
    !sameAccessHandle(expectedRoute, descriptor.route)) {
    throw new TypeError("Runtime lookup receipt does not match the native attachment target.");
  }
}

function validateDelegationRuntime(item: OutboxItem, result: unknown): void {
  const payload = z.strictObject({ delegation: z.strictObject({
    precreatedNativeSession: NativeRefSchema.optional(),
  }).passthrough(), route: z.strictObject({ id: z.string(), ownerInstallationId: z.string(),
    kind: z.string(), expiresAt: z.string().optional() }) }).passthrough().parse(item.payload);
  const descriptor = RuntimeBindingDescriptorSchema.parse(result);
  const expectedNative = payload.delegation.precreatedNativeSession;
  const expectedOrigin = expectedNative === undefined ? "created" : "provider_precreated";
  if ((expectedNative !== undefined && !sameNativeRef(expectedNative, descriptor.nativeSession)) ||
    descriptor.origin !== expectedOrigin || descriptor.controlGrant.mode !== "control" ||
    !sameAccessHandle(payload.route, descriptor.route)) {
    throw new TypeError("Runtime lookup receipt does not match the delegated session target.");
  }
}

function validateDelegationAdvance(item: OutboxItem, result: unknown): void {
  const payload = z.strictObject({ sessionId: z.string(), environment: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("none") }),
    z.strictObject({ mode: z.literal("provision"), releasePolicyRef: z.string() }).passthrough(),
  ]) }).passthrough().parse(item.payload);
  if (payload.environment.mode === "provision") {
    const allocation = AllocationDescriptorSchema.parse(result);
    if (!allocation.ready || allocation.allocationRef.installationId !== item.installationId ||
      allocation.allocationRef.installationId !== allocation.identity.native.installationId ||
      allocation.allocationRef.providerScope !== allocation.identity.native.providerScope ||
      !sameNativeRef(allocation.allocationRef, allocation.lifecycleGrant.allocationRef) ||
      allocation.lifecycleGrant.releasePolicyRef !== payload.environment.releasePolicyRef ||
      !allocation.lifecycleGrant.allowedActions.includes("release_allocation")) {
      throw new TypeError("Allocation lookup receipt does not match the persisted request and provider.");
    }
    return;
  }
  const descriptor = RuntimeBindingDescriptorSchema.parse(result);
  const expectedRoute = {
    id: `external:${payload.sessionId}`, ownerInstallationId: item.installationId,
    kind: "simulated_external",
  };
  if (descriptor.origin !== "created" || descriptor.controlGrant.mode !== "control" ||
    !sameAccessHandle(expectedRoute, descriptor.route)) {
    throw new TypeError("Runtime lookup receipt does not match the environment-free session target.");
  }
}

function sameNativeRef(left: z.infer<typeof NativeRefSchema>, right: z.infer<typeof NativeRefSchema>): boolean {
  return left.installationId === right.installationId && left.providerScope === right.providerScope &&
    left.kind === right.kind && left.id === right.id && left.incarnation === right.incarnation;
}

function sameAccessHandle(
  left: { readonly id: string; readonly ownerInstallationId: string; readonly kind: string;
    readonly expiresAt?: string | undefined },
  right: { readonly id: string; readonly ownerInstallationId: string; readonly kind: string;
    readonly expiresAt?: string | undefined },
): boolean {
  return left.id === right.id && left.ownerInstallationId === right.ownerInstallationId &&
    left.kind === right.kind && left.expiresAt === right.expiresAt;
}

function connectorOperationKind(item: OutboxItem): string {
  switch (item.operationKind) {
    case "delegation.advance": {
      const environment = Reflect.get(item.payload, "environment");
      const mode = typeof environment === "object" && environment !== null
        ? Reflect.get(environment, "mode") : undefined;
      if (mode === "provision") return "execution.requestAllocation";
      if (mode === "none") return "runtime.openSession";
      throw new TypeError("Delegation lookup has no mutating connector operation.");
    }
    case "execution.attachForDelegation":
    case "session.attachEnvironment": return "execution.attach";
    case "runtime.openForDelegation":
    case "session.attachExisting": return "runtime.openSession";
    case "runtime.startAttempt": return "runtime.startAttempt";
    case "runtime.sendInstruction": return "runtime.sendInstruction";
    case "runtime.deliverResponse": return "runtime.deliverResponse";
    case "runtime.requestStop": return "runtime.requestStop";
    case "runtime.requestControl": return "runtime.requestControl";
    case "runtime.detachSession": return "runtime.detachSession";
    case "execution.detachAttachment":
    case "execution.detachCanceledAttachment": return "execution.detachAttachment";
    case "execution.releaseAllocation":
    case "execution.releaseCanceledAllocation": return "execution.releaseAllocation";
    case "execution.cancelOperation": return "execution.cancelOperation";
    default: throw new TypeError(`No connector receipt kind for ${item.operationKind}.`);
  }
}
