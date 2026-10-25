import { z } from "zod";

export type Id = string;
export type Revision = number;
export type Timestamp = string;
export type Digest = string;
export type Cursor = string;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);
export const TimestampSchema = z.iso.datetime();
export const DigestSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*:.+$/);

export const NativeRefSchema = z.strictObject({
  installationId: z.string().min(1), providerScope: z.string().min(1), kind: z.string().min(1), id: z.string().min(1),
  incarnation: z.string().min(1).optional(),
});
export interface NativeRef extends z.infer<typeof NativeRefSchema> {}

export const SecretRefSchema = z.strictObject({ id: z.string().min(1), purpose: z.string().min(1) });
export interface SecretRef extends z.infer<typeof SecretRefSchema> {}

export const AccessHandleRefSchema = z.strictObject({
  id: z.string().min(1), ownerInstallationId: z.string().min(1), kind: z.string().min(1), expiresAt: TimestampSchema.optional(),
});
export interface AccessHandleRef extends z.infer<typeof AccessHandleRefSchema> {}

export interface Observation<T> {
  readonly value: T;
  readonly sourceInstallationId: Id;
  readonly observedAt: Timestamp;
  readonly sourceCursor?: Cursor;
  readonly assurance: "authoritative" | "reported" | "partial";
  readonly limitations: readonly string[];
}

export const CapabilitySchema = z.strictObject({
  support: z.enum(["supported", "unsupported", "unknown"]),
  implementation: z.enum(["native", "bridge", "connector"]).optional(), limitations: z.array(z.string()),
});
export interface Capability extends z.infer<typeof CapabilitySchema> {}

export const OperationSafetySchema = z.strictObject({
  deduplicatesByClientOperationId: z.boolean(), lookupByClientOperationId: z.boolean(),
  replayAfterUnknown: z.enum(["same_id_only", "never"]),
}).superRefine((value, context) => {
  if (value.replayAfterUnknown === "same_id_only" && !value.deduplicatesByClientOperationId) {
    context.addIssue({ code: "custom", path: ["replayAfterUnknown"], message: "same_id_only requires client-operation deduplication" });
  }
});
export interface OperationSafety extends z.infer<typeof OperationSafetySchema> {}

export const ConnectorManifestSchema = z.strictObject({
  id: z.string().min(1), kind: z.enum(["execution", "agent_runtime"]), implementationVersion: z.string().min(1),
  contractMajor: z.literal(1), configurationSchemaId: z.string().min(1), requiredSecretPurposes: z.array(z.string()),
  requiredPermissions: z.array(z.string()), operationSafety: z.record(z.string(), OperationSafetySchema), extensions: JsonObjectSchema.optional(),
});
export interface ConnectorManifest extends z.infer<typeof ConnectorManifestSchema> {}

export const CallContextSchema = z.strictObject({
  workspaceId: z.string().min(1), installationId: z.string().min(1), correlationId: z.string().min(1),
  deadlineAt: TimestampSchema.optional(),
});
export interface CallContext extends z.infer<typeof CallContextSchema> {
  readonly signal?: AbortSignal;
}

export const ActionContextSchema = CallContextSchema.extend({
  commandId: z.string().min(1), operationId: z.string().min(1), inputDigest: DigestSchema, authorizedGrantRefs: z.array(z.string()),
}).strict();
export interface ActionContext extends z.infer<typeof ActionContextSchema> {}

export const ConnectorErrorSchema = z.strictObject({
  code: z.string().min(1),
  category: z.enum(["validation", "authorization", "authentication", "conflict", "identity_mismatch", "unavailable", "unsupported", "requirements_not_met", "timeout", "provider_failure"]),
  message: z.string(), retry: z.enum(["read_only_retry", "same_operation_if_deduplicated", "reconcile_first", "manual_action", "never"]),
  details: JsonObjectSchema.optional(),
});
export interface ConnectorError extends z.infer<typeof ConnectorErrorSchema> {}

export const EffectEvidenceSchema = z.strictObject({
  effect: z.string().min(1), source: z.enum(["provider_receipt", "state_inspection", "runtime_ack", "explicit_bridge_ack"]),
  observedAt: TimestampSchema, providerReference: NativeRefSchema.optional(), detail: JsonObjectSchema.optional(),
});
export interface EffectEvidence extends z.infer<typeof EffectEvidenceSchema> {}

export const PartialEffectSchema = z.strictObject({
  description: z.string(), resource: NativeRefSchema.optional(),
  disposition: z.enum(["retained", "cleanup_pending", "cleanup_failed", "unknown"]),
});
export interface PartialEffect extends z.infer<typeof PartialEffectSchema> {}

const OperationBaseSchema = z.strictObject({
  operationId: z.string().min(1), operationKind: z.string().min(1), resultSchemaId: z.string().min(1),
  providerReceiptRef: NativeRefSchema.optional(), updatedAt: TimestampSchema, partialEffects: z.array(PartialEffectSchema),
});

export const SerializedOperationReceiptSchema = z.discriminatedUnion("status", [
  OperationBaseSchema.extend({ status: z.literal("accepted"), progress: z.string().optional() }).strict(),
  OperationBaseSchema.extend({ status: z.literal("running"), progress: z.string().optional() }).strict(),
  OperationBaseSchema.extend({ status: z.literal("confirmed"), result: JsonValueSchema, evidence: EffectEvidenceSchema }).strict(),
  OperationBaseSchema.extend({ status: z.literal("rejected"), error: ConnectorErrorSchema }).strict(),
  OperationBaseSchema.extend({ status: z.literal("failed"), error: ConnectorErrorSchema }).strict(),
  OperationBaseSchema.extend({ status: z.literal("unknown"), error: ConnectorErrorSchema, reconciliationHint: z.string().optional() }).strict(),
]);
export type SerializedOperationReceipt = z.infer<typeof SerializedOperationReceiptSchema>;

export type OperationReceipt<T> = {
  readonly operationId: Id; readonly operationKind: string; readonly resultSchemaId: string;
  readonly providerReceiptRef?: NativeRef; readonly updatedAt: Timestamp; readonly partialEffects: readonly PartialEffect[];
} & (
  | { readonly status: "accepted" | "running"; readonly progress?: string }
  | { readonly status: "confirmed"; readonly result: T; readonly evidence: EffectEvidence }
  | { readonly status: "rejected" | "failed"; readonly error: ConnectorError }
  | { readonly status: "unknown"; readonly error: ConnectorError; readonly reconciliationHint?: string }
);

export type OperationLookup =
  | { readonly kind: "found"; readonly receipt: OperationReceipt<JsonValue> }
  | { readonly kind: "not_found"; readonly absence: "proven_not_executed" | "not_authoritative" }
  | { readonly kind: "unsupported"; readonly reason: string };

export function parseSerializedOperationReceipt(value: unknown): SerializedOperationReceipt {
  return SerializedOperationReceiptSchema.parse(value);
}
