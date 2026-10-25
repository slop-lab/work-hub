import { z } from "zod";
import type { ActionContext, CallContext, ConnectorManifest, EffectEvidence, Id, JsonObject, NativeRef, Observation, OperationLookup, OperationReceipt, Revision, Timestamp } from "./common.ts";
import { AccessHandleRefSchema, EffectEvidenceSchema, JsonObjectSchema, NativeRefSchema, TimestampSchema } from "./common.ts";

export const WorkAreaSchema = z.strictObject({ key: z.string(), path: z.string(), pathNamespace: z.string(), requestedAccess: z.enum(["read", "write"]), preparation: z.enum(["preserve_existing", "provider_profile"]), expectedContentRevision: z.string().optional() });
export interface WorkArea extends z.infer<typeof WorkAreaSchema> {}
export const ResourceIdentitySchema = z.strictObject({ native: NativeRefSchema, assurance: z.enum(["immutable", "attested", "weak"]), continuityToken: z.string().optional() });
export interface ResourceIdentity extends z.infer<typeof ResourceIdentitySchema> {}
export const EnvironmentUseGrantSchema = z.strictObject({ id: z.string(), allowedWorkAreas: z.array(WorkAreaSchema), runtimeServiceLaunch: z.boolean(), enforcement: z.enum(["enforced", "advisory", "unknown"]), exclusivity: z.enum(["external_enforced", "hub_only", "none"]), expiresAt: TimestampSchema.optional(), limitations: z.array(z.string()) });
export interface EnvironmentUseGrant extends z.infer<typeof EnvironmentUseGrantSchema> {}
export const LifecycleGrantSchema = z.strictObject({ id: z.string(), allocationRef: NativeRefSchema, releasePolicyRef: z.string(), allowedActions: z.array(z.enum(["release_allocation", "cancel_preparation"])), expiresAt: TimestampSchema.optional() });
export interface LifecycleGrant extends z.infer<typeof LifecycleGrantSchema> {}

export const ExistingEnvironmentRegistrationSchema = z.strictObject({
  id: z.string(), revision: z.number().int().nonnegative(), label: z.string(), executionInstallationId: z.string(), locator: JsonObjectSchema,
  secretRefs: z.array(z.strictObject({ id: z.string(), purpose: z.string() })), allowedProjectIds: z.array(z.string()), allowedWorkAreas: z.array(WorkAreaSchema),
  allowRuntimeServiceLaunch: z.boolean(), verifiedIdentity: ResourceIdentitySchema.optional(), verifiedAt: TimestampSchema.optional(), weakIdentityExplicitlyAccepted: z.boolean(), retiredAt: TimestampSchema.optional(),
});
export interface ExistingEnvironmentRegistration extends z.infer<typeof ExistingEnvironmentRegistrationSchema> {}

export type EnvironmentSelection =
  | { readonly mode: "provision"; readonly executionInstallationId: Id; readonly externalProfileRef: string; readonly parameters: JsonObject; readonly releasePolicyRef: string; readonly workAreas: readonly WorkArea[] }
  | { readonly mode: "existing"; readonly registrationId: Id; readonly expectedRegistrationRevision: Revision; readonly workAreas: readonly WorkArea[]; readonly requestedAccess: "read" | "write" }
  | { readonly mode: "none" };
export const EnvironmentSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("provision"), executionInstallationId: z.string(), externalProfileRef: z.string(), parameters: JsonObjectSchema, releasePolicyRef: z.string(), workAreas: z.array(WorkAreaSchema) }),
  z.strictObject({ mode: z.literal("existing"), registrationId: z.string(), expectedRegistrationRevision: z.number().int().nonnegative(), workAreas: z.array(WorkAreaSchema), requestedAccess: z.enum(["read", "write"]) }),
  z.strictObject({ mode: z.literal("none") }),
]);
export interface EnvironmentProbe { readonly identity: ResourceIdentity; readonly observedState: "running" | "stopped" | "missing" | "unknown"; readonly availableWorkAreas: readonly WorkArea[]; readonly availableUseGrant: EnvironmentUseGrant; readonly routeKinds: readonly string[]; readonly unmetRequirements: readonly string[] }
export interface AllocationRequest { readonly taskId: Id; readonly sessionId: Id; readonly attemptId: Id; readonly externalProfileRef: string; readonly parameters: JsonObject; readonly releasePolicyRef: string; readonly workAreas: readonly WorkArea[]; readonly allowedPreparationEffects: readonly string[] }
export interface AllocationDescriptor { readonly allocationRef: NativeRef; readonly identity: ResourceIdentity; readonly lifecycleGrant: LifecycleGrant; readonly ready: boolean; readonly precreatedNativeSession?: NativeRef | undefined }
export type AttachmentTarget =
  | { readonly kind: "registered_existing"; readonly registration: ExistingEnvironmentRegistration; readonly expectedIdentity: ResourceIdentity }
  | { readonly kind: "allocation"; readonly allocationRef: NativeRef; readonly expectedIdentity: ResourceIdentity; readonly lifecycleGrant: LifecycleGrant };
export interface AttachmentRequest { readonly hubBindingId: Id; readonly hubBindingGeneration: number; readonly projectId: Id; readonly taskId: Id; readonly sessionId: Id; readonly attemptId?: Id; readonly target: AttachmentTarget; readonly workAreas: readonly WorkArea[]; readonly requestedAccess: "read" | "write"; readonly preparation: "preserve_existing" }
export interface EnvironmentAttachment { readonly hubBindingId: Id; readonly hubBindingGeneration: number; readonly attachmentRef: NativeRef; readonly identity: ResourceIdentity; readonly origin: "registered_existing" | "allocated"; readonly routes: readonly z.infer<typeof AccessHandleRefSchema>[]; readonly useGrant: EnvironmentUseGrant; readonly lifecycleGrant?: LifecycleGrant | undefined }
export interface BindingObservation { readonly identity: ResourceIdentity; readonly state: "running" | "stopped" | "missing" | "unknown"; readonly attachmentValid: boolean | "unknown"; readonly grantValid: boolean | "unknown"; readonly knownExternalActivity: "idle" | "active" | "unknown"; readonly limitations: readonly string[] }
export interface AllocationRelease { readonly allocationRef: NativeRef; readonly expectedIdentity: ResourceIdentity; readonly lifecycleGrant: LifecycleGrant; readonly releasePolicyRef: string; readonly controlledWorkTermination: { readonly status: "confirmed"; readonly evidence: EffectEvidence } | { readonly status: "no_controlled_work" } | { readonly status: "unknown"; readonly operatorDecisionRef: Id }; readonly preservationDecisionRef: Id }
export interface ReleaseResult { readonly disposition: "retained" | "stopped" | "deleted" | "provider_managed"; readonly referenceAvailability: "preserved" | "may_expire" | "unknown" }

export const AllocationRequestSchema = z.strictObject({ taskId: z.string(), sessionId: z.string(), attemptId: z.string(), externalProfileRef: z.string(), parameters: JsonObjectSchema, releasePolicyRef: z.string(), workAreas: z.array(WorkAreaSchema), allowedPreparationEffects: z.array(z.string()) });
export const AttachmentRequestSchema = z.strictObject({ hubBindingId: z.string(), hubBindingGeneration: z.number().int().nonnegative(), projectId: z.string(), taskId: z.string(), sessionId: z.string(), attemptId: z.string().optional(), target: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("registered_existing"), registration: ExistingEnvironmentRegistrationSchema, expectedIdentity: ResourceIdentitySchema }), z.strictObject({ kind: z.literal("allocation"), allocationRef: NativeRefSchema, expectedIdentity: ResourceIdentitySchema, lifecycleGrant: LifecycleGrantSchema })]), workAreas: z.array(WorkAreaSchema), requestedAccess: z.enum(["read", "write"]), preparation: z.literal("preserve_existing") });
export const EnvironmentAttachmentSchema = z.strictObject({ hubBindingId: z.string(), hubBindingGeneration: z.number().int().nonnegative(), attachmentRef: NativeRefSchema, identity: ResourceIdentitySchema, origin: z.enum(["registered_existing", "allocated"]), routes: z.array(AccessHandleRefSchema), useGrant: EnvironmentUseGrantSchema, lifecycleGrant: LifecycleGrantSchema.optional() });
export const EnvironmentProbeSchema = z.strictObject({ identity: ResourceIdentitySchema, observedState: z.enum(["running", "stopped", "missing", "unknown"]), availableWorkAreas: z.array(WorkAreaSchema), availableUseGrant: EnvironmentUseGrantSchema, routeKinds: z.array(z.string()), unmetRequirements: z.array(z.string()) });
export const AllocationDescriptorSchema = z.strictObject({ allocationRef: NativeRefSchema, identity: ResourceIdentitySchema, lifecycleGrant: LifecycleGrantSchema, ready: z.boolean(), precreatedNativeSession: NativeRefSchema.optional() });
export const BindingObservationSchema = z.strictObject({ identity: ResourceIdentitySchema, state: z.enum(["running", "stopped", "missing", "unknown"]), attachmentValid: z.union([z.boolean(), z.literal("unknown")]), grantValid: z.union([z.boolean(), z.literal("unknown")]), knownExternalActivity: z.enum(["idle", "active", "unknown"]), limitations: z.array(z.string()) });
export const AllocationReleaseSchema = z.strictObject({ allocationRef: NativeRefSchema, expectedIdentity: ResourceIdentitySchema, lifecycleGrant: LifecycleGrantSchema, releasePolicyRef: z.string(), controlledWorkTermination: z.discriminatedUnion("status", [z.strictObject({ status: z.literal("confirmed"), evidence: EffectEvidenceSchema }), z.strictObject({ status: z.literal("no_controlled_work") }), z.strictObject({ status: z.literal("unknown"), operatorDecisionRef: z.string() })]), preservationDecisionRef: z.string() });
export const ReleaseResultSchema = z.strictObject({ disposition: z.enum(["retained", "stopped", "deleted", "provider_managed"]), referenceAvailability: z.enum(["preserved", "may_expire", "unknown"]) });
export const CancellationResultSchema = z.strictObject({ cancellationConfirmed: z.boolean() });
export const DetachedResultSchema = z.strictObject({ detached: z.literal(true) });

export interface ExecutionConnector {
  describe(): ConnectorManifest;
  probeExisting(ctx: CallContext, registration: ExistingEnvironmentRegistration): Promise<Observation<EnvironmentProbe>>;
  requestAllocation(ctx: ActionContext, input: AllocationRequest): Promise<OperationReceipt<AllocationDescriptor>>;
  attach(ctx: ActionContext, input: AttachmentRequest): Promise<OperationReceipt<EnvironmentAttachment>>;
  inspectBinding(ctx: CallContext, attachment: EnvironmentAttachment): Promise<Observation<BindingObservation>>;
  lookupOperation(ctx: CallContext, operationId: Id): Promise<OperationLookup>;
  cancelOperation(ctx: ActionContext, operationIdToCancel: Id): Promise<OperationReceipt<{ readonly cancellationConfirmed: boolean }>>;
  detachAttachment(ctx: ActionContext, input: { readonly attachmentRef: NativeRef; readonly expectedIdentity: ResourceIdentity }): Promise<OperationReceipt<{ readonly detached: true }>>;
  releaseAllocation(ctx: ActionContext, input: AllocationRelease): Promise<OperationReceipt<ReleaseResult>>;
}
