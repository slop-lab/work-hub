import type { ActionContext, AllocationDescriptor, AllocationRelease, AllocationRequest, AttachmentRequest, BindingObservation, CallContext, ConnectorManifest, EnvironmentAttachment, EnvironmentProbe, ExecutionConnector, ExistingEnvironmentRegistration, Id, JsonObject, Observation, OperationLookup, OperationReceipt, ReleaseResult, ResourceIdentity } from "../contracts/index.ts";
import { AllocationDescriptorSchema, CancellationResultSchema, DetachedResultSchema, EnvironmentAttachmentSchema, JsonObjectSchema, ReleaseResultSchema } from "../contracts/index.ts";
import { executeOperation, rejected } from "./operation.ts";
import type { SimulatorStore } from "./store.ts";
import { SimulatedReleaseResultSchema } from "./types.ts";

const identityFor = (id: string, installationId: string, assurance: "immutable" | "attested" | "weak", incarnation: string): ResourceIdentity => ({ native: { installationId, providerScope: "simulated", kind: "environment", id, incarnation }, assurance, continuityToken: `sim:${id}:${incarnation}` });
const json = (value: unknown): JsonObject => JsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));

export class SimulatedExecutionConnector implements ExecutionConnector {
  readonly #store: SimulatorStore;
  constructor(store: SimulatorStore) { this.#store = store; }
  describe(): ConnectorManifest {
    const safety = { deduplicatesByClientOperationId: true, lookupByClientOperationId: true, replayAfterUnknown: "same_id_only" as const };
    return { id: "workhub.simulator.execution", kind: "execution", implementationVersion: "0.3.0", contractMajor: 1, configurationSchemaId: "workhub.simulator.execution.config.v1", requiredSecretPurposes: [], requiredPermissions: [], operationSafety: { requestAllocation: safety, attach: safety, cancelOperation: safety, detachAttachment: safety, releaseAllocation: safety }, extensions: { simulated: true } };
  }
  async probeExisting(ctx: CallContext, registration: ExistingEnvironmentRegistration): Promise<Observation<EnvironmentProbe>> {
    this.#store.recordCall("execution", "execution.probeExisting", json(registration));
    const state = this.#store.getEnvironment(registration.id);
    const limitations = state.assurance === "weak" ? ["weak_identity_requires_explicit_confirmation"] : [];
    const unmetRequirements = state.state === "running" ? [] : [`environment_${state.state}`];
    return { value: { identity: identityFor(registration.id, ctx.installationId, state.assurance, state.incarnation), observedState: state.state, availableWorkAreas: registration.allowedWorkAreas, availableUseGrant: { id: `use:${registration.id}`, allowedWorkAreas: registration.allowedWorkAreas, runtimeServiceLaunch: registration.allowRuntimeServiceLaunch, enforcement: state.assurance === "weak" ? "advisory" : "enforced", exclusivity: state.externalActivity === "active" ? "none" : "hub_only", limitations }, routeKinds: ["simulated"], unmetRequirements }, sourceInstallationId: ctx.installationId, observedAt: this.#store.now(), assurance: state.assurance === "weak" ? "partial" : "authoritative", limitations };
  }
  async requestAllocation(ctx: ActionContext, input: AllocationRequest): Promise<OperationReceipt<AllocationDescriptor>> {
    return executeOperation<AllocationDescriptor>(this.#store, ctx, { connector: "execution", kind: "execution.requestAllocation", resultSchemaId: "workhub.execution.allocation.v1", resultSchema: AllocationDescriptorSchema, input: json(input), evidenceEffect: "allocation.ready", effect: () => {
      const allocationRef = { installationId: ctx.installationId, providerScope: "simulated", kind: "allocation", id: `allocation:${input.attemptId}`, incarnation: "v1" };
      const identity = identityFor(allocationRef.id, ctx.installationId, "immutable", "v1");
      this.#store.setEnvironment(allocationRef.id, { state: "running", assurance: "immutable", externalActivity: "idle", incarnation: "v1" });
      return { allocationRef, identity, lifecycleGrant: { id: `lifecycle:${allocationRef.id}`, allocationRef, releasePolicyRef: input.releasePolicyRef, allowedActions: ["release_allocation", "cancel_preparation"] }, ready: true };
    } });
  }
  async attach(ctx: ActionContext, input: AttachmentRequest): Promise<OperationReceipt<EnvironmentAttachment>> {
    const id = input.target.kind === "registered_existing" ? input.target.registration.id : input.target.allocationRef.id;
    const current = this.#store.getEnvironment(id);
    if (current.state !== "running") return rejected(ctx, "execution.attach", "workhub.execution.attachment.v1", { code: `environment_${current.state}`, category: "requirements_not_met", message: "The target is not ready for attachment.", retry: "manual_action" });
    if (input.target.expectedIdentity.native.incarnation !== current.incarnation) return rejected(ctx, "execution.attach", "workhub.execution.attachment.v1", { code: "identity_replaced", category: "identity_mismatch", message: "The target incarnation changed after verification.", retry: "manual_action" });
    return executeOperation<EnvironmentAttachment>(this.#store, ctx, { connector: "execution", kind: "execution.attach", resultSchemaId: "workhub.execution.attachment.v1", resultSchema: EnvironmentAttachmentSchema, input: json(input), evidenceEffect: "binding.attached", effect: () => {
      const identity = identityFor(id, ctx.installationId, current.assurance, current.incarnation);
      const lifecycleGrant = input.target.kind === "allocation" ? input.target.lifecycleGrant : undefined;
      return { hubBindingId: input.hubBindingId, hubBindingGeneration: input.hubBindingGeneration, attachmentRef: { installationId: ctx.installationId, providerScope: "simulated", kind: "attachment", id: `attachment:${input.hubBindingId}`, incarnation: String(input.hubBindingGeneration) }, identity, origin: input.target.kind === "allocation" ? "allocated" as const : "registered_existing" as const, routes: [{ id: `route:${input.hubBindingId}`, ownerInstallationId: ctx.installationId, kind: "simulated" }], useGrant: { id: `use:${input.hubBindingId}`, allowedWorkAreas: [...input.workAreas], runtimeServiceLaunch: false, enforcement: current.assurance === "weak" ? "advisory" as const : "enforced" as const, exclusivity: current.externalActivity === "active" ? "none" as const : "hub_only" as const, limitations: current.externalActivity === "active" ? ["known_external_activity"] : [] }, ...(lifecycleGrant === undefined ? {} : { lifecycleGrant }) };
    } });
  }
  async inspectBinding(ctx: CallContext, attachment: EnvironmentAttachment): Promise<Observation<BindingObservation>> {
    this.#store.recordCall("execution", "execution.inspectBinding", json(attachment));
    const state = this.#store.getEnvironment(attachment.identity.native.id);
    const identity = identityFor(attachment.identity.native.id, ctx.installationId, state.assurance, state.incarnation);
    const matches = state.incarnation === attachment.identity.native.incarnation;
    return { value: { identity, state: state.state, attachmentValid: matches && state.state === "running", grantValid: matches, knownExternalActivity: state.externalActivity, limitations: matches ? [] : ["identity_replaced"] }, sourceInstallationId: ctx.installationId, observedAt: this.#store.now(), assurance: "authoritative", limitations: [] };
  }
  async lookupOperation(_ctx: CallContext, operationId: Id): Promise<OperationLookup> { return this.#store.lookup(operationId); }
  async cancelOperation(ctx: ActionContext, operationIdToCancel: Id): Promise<OperationReceipt<{ readonly cancellationConfirmed: boolean }>> { return executeOperation(this.#store, ctx, { connector: "execution", kind: "execution.cancelOperation", resultSchemaId: "workhub.execution.cancellation.v1", resultSchema: CancellationResultSchema, input: { operationIdToCancel }, evidenceEffect: "operation.cancellation_confirmed", effect: () => ({ cancellationConfirmed: true }) }); }
  async detachAttachment(ctx: ActionContext, input: { readonly attachmentRef: import("../contracts/index.ts").NativeRef; readonly expectedIdentity: ResourceIdentity }): Promise<OperationReceipt<{ readonly detached: true }>> { return executeOperation(this.#store, ctx, { connector: "execution", kind: "execution.detachAttachment", resultSchemaId: "workhub.execution.detached.v1", resultSchema: DetachedResultSchema, input: json(input), evidenceEffect: "binding.detached", effect: () => ({ detached: true }) }); }
  async releaseAllocation(ctx: ActionContext, input: AllocationRelease): Promise<OperationReceipt<ReleaseResult>> {
    if (!input.lifecycleGrant.allowedActions.includes("release_allocation")) return rejected(ctx, "execution.releaseAllocation", "workhub.execution.release.v1", { code: "release_not_granted", category: "authorization", message: "The lifecycle grant does not authorize allocation release.", retry: "never" });
    return executeOperation(this.#store, ctx, { connector: "execution", kind: "execution.releaseAllocation", resultSchemaId: "workhub.execution.release.v1", resultSchema: ReleaseResultSchema, input: json(input), evidenceEffect: "allocation.release_policy_applied", effect: () => {
      const configured = this.#store.getState(`release:${input.allocationRef.id}`);
      if (configured !== undefined) return SimulatedReleaseResultSchema.parse(JSON.parse(configured));
      if (input.releasePolicyRef.includes("retain")) return { disposition: "retained", referenceAvailability: "preserved" };
      if (input.releasePolicyRef.includes("stop")) return { disposition: "stopped", referenceAvailability: "may_expire" };
      if (input.releasePolicyRef.includes("delete")) return { disposition: "deleted", referenceAvailability: "may_expire" };
      return { disposition: "provider_managed", referenceAvailability: "unknown" };
    } });
  }
}
