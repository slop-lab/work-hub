import { createHash } from "node:crypto";
import type { ActionContext, AllocationDescriptor, AllocationRelease, AllocationRequest, AttachmentRequest, BindingObservation, CallContext, ConnectorManifest, EnvironmentAttachment, EnvironmentProbe, ExecutionConnector, ExistingEnvironmentRegistration, Id, JsonObject, LifecycleGrant, NativeRef, Observation, OperationLookup, OperationReceipt, ReleaseResult, ResourceIdentity } from "../contracts/index.ts";
import { AllocationDescriptorSchema, CancellationResultSchema, DetachedResultSchema, EnvironmentAttachmentSchema, JsonObjectSchema, ReleaseResultSchema } from "../contracts/index.ts";
import { completeWaitingOperation, executeOperation, rejected } from "./operation.ts";
import type { SimulatorStore } from "./store.ts";
import { SimulatedReleaseResultSchema } from "./types.ts";

const identityFor = (id: string, installationId: string, assurance: "immutable" | "attested" | "weak", incarnation: string): ResourceIdentity => ({ native: { installationId, providerScope: "simulated", kind: "environment", id, incarnation }, assurance, continuityToken: `sim:${id}:${incarnation}` });
const json = (value: unknown): JsonObject => JsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
const sameNativeRef = (left: NativeRef, right: NativeRef): boolean => left.installationId === right.installationId && left.providerScope === right.providerScope && left.kind === right.kind && left.id === right.id && left.incarnation === right.incarnation;
const sameIdentity = (left: ResourceIdentity, right: ResourceIdentity): boolean => sameNativeRef(left.native, right.native) && left.assurance === right.assurance && left.continuityToken === right.continuityToken;
const sameLifecycleGrant = (left: LifecycleGrant, right: LifecycleGrant): boolean => left.id === right.id && sameNativeRef(left.allocationRef, right.allocationRef) && left.releasePolicyRef === right.releasePolicyRef && left.expiresAt === right.expiresAt && left.allowedActions.length === right.allowedActions.length && left.allowedActions.every((action, index) => action === right.allowedActions[index]);
const providerEnvironmentId = (installationId: string, registration: ExistingEnvironmentRegistration): string => {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sort(item)]));
  };
  return `environment:${createHash("sha256").update(`${installationId}\0${JSON.stringify(sort(registration.locator))}`).digest("hex")}`;
};

export class SimulatedExecutionConnector implements ExecutionConnector {
  readonly #store: SimulatorStore;
  constructor(store: SimulatorStore) { this.#store = store; }
  describe(): ConnectorManifest {
    const safety = { deduplicatesByClientOperationId: true, lookupByClientOperationId: true, replayAfterUnknown: "same_id_only" as const };
    return { id: "workhub.simulator.execution", kind: "execution", implementationVersion: "0.3.0", contractMajor: 1, configurationSchemaId: "workhub.simulator.execution.config.v1", requiredSecretPurposes: [], requiredPermissions: [], operationSafety: { requestAllocation: safety, attach: safety, cancelOperation: safety, detachAttachment: safety, releaseAllocation: safety }, extensions: { simulated: true } };
  }
  async probeExisting(ctx: CallContext, registration: ExistingEnvironmentRegistration): Promise<Observation<EnvironmentProbe>> {
    this.#store.recordCall("execution", "execution.probeExisting", json(registration));
    const id = providerEnvironmentId(ctx.installationId, registration);
    this.#store.bindEnvironmentAlias(registration.id, id);
    const state = this.#store.getEnvironment(id);
    const limitations = state.assurance === "weak" ? ["weak_identity_requires_explicit_confirmation"] : [];
    const unmetRequirements = state.state === "running" ? [] : [`environment_${state.state}`];
    return { value: { identity: identityFor(id, ctx.installationId, state.assurance, state.incarnation), observedState: state.state, availableWorkAreas: registration.allowedWorkAreas,
      availableUseGrant: { id: `use:${registration.id}`, allowedWorkAreas: registration.allowedWorkAreas, runtimeServiceLaunch: registration.allowRuntimeServiceLaunch, enforcement: state.assurance === "weak" ? "advisory" : "enforced", exclusivity: state.externalActivity === "active" ? "none" : "hub_only", limitations }, routeKinds: ["simulated"], unmetRequirements },
      sourceInstallationId: ctx.installationId, observedAt: this.#store.now(), assurance: state.assurance === "weak" ? "partial" : "authoritative", limitations };
  }
  async requestAllocation(ctx: ActionContext, input: AllocationRequest): Promise<OperationReceipt<AllocationDescriptor>> {
    const receipt = executeOperation<AllocationDescriptor>(this.#store, ctx, { connector: "execution", kind: "execution.requestAllocation", resultSchemaId: "workhub.execution.allocation.v1", resultSchema: AllocationDescriptorSchema, input: json(input), evidenceEffect: "allocation.ready", effect: () => this.#constructAllocation(ctx, input) });
    if (receipt.status === "accepted") this.#store.putPendingAllocation(ctx.operationId, ctx, input);
    return receipt;
  }
  completeAllocation(operationId: Id): OperationReceipt<AllocationDescriptor> {
    const pending = this.#store.getPendingAllocation(operationId);
    if (pending === undefined) throw new TypeError("No waiting allocation is recorded for this operation.");
    return completeWaitingOperation(this.#store, operationId, AllocationDescriptorSchema, "allocation.ready", () => this.#constructAllocation(pending.context, pending.request));
  }
  async attach(ctx: ActionContext, input: AttachmentRequest): Promise<OperationReceipt<EnvironmentAttachment>> {
    const id = input.target.kind === "registered_existing" ? providerEnvironmentId(ctx.installationId, input.target.registration) : input.target.allocationRef.id;
    if (input.target.kind === "registered_existing") this.#store.bindEnvironmentAlias(input.target.registration.id, id);
    const current = this.#store.getEnvironment(id);
    if (current.state !== "running") return rejected(ctx, "execution.attach", "workhub.execution.attachment.v1", { code: `environment_${current.state}`, category: "requirements_not_met", message: "The target is not ready for attachment.", retry: "manual_action" });
    const identity = identityFor(id, ctx.installationId, current.assurance, current.incarnation);
    if (!sameIdentity(input.target.expectedIdentity, identity)) return rejected(ctx, "execution.attach", "workhub.execution.attachment.v1", { code: "identity_replaced", category: "identity_mismatch", message: "The target identity changed after verification.", retry: "manual_action" });
    return executeOperation<EnvironmentAttachment>(this.#store, ctx, { connector: "execution", kind: "execution.attach", resultSchemaId: "workhub.execution.attachment.v1", resultSchema: EnvironmentAttachmentSchema, input: json(input), evidenceEffect: "binding.attached", effect: () => {
      const lifecycleGrant = input.target.kind === "allocation" ? input.target.lifecycleGrant : undefined;
      const attachmentRef = { installationId: ctx.installationId, providerScope: "simulated", kind: "attachment", id: `attachment:${input.hubBindingId}`, incarnation: String(input.hubBindingGeneration) };
      this.#store.putAttachment(attachmentRef, identity);
      return { hubBindingId: input.hubBindingId, hubBindingGeneration: input.hubBindingGeneration, attachmentRef, identity, origin: input.target.kind === "allocation" ? "allocated" as const : "registered_existing" as const,
        routes: [{ id: `route:${input.hubBindingId}`, ownerInstallationId: ctx.installationId, kind: "simulated" }], useGrant: { id: `use:${input.hubBindingId}`, allowedWorkAreas: [...input.workAreas], runtimeServiceLaunch: false, enforcement: current.assurance === "weak" ? "advisory" as const : "enforced" as const,
          exclusivity: current.externalActivity === "active" ? "none" as const : "hub_only" as const, limitations: current.externalActivity === "active" ? ["known_external_activity"] : [] }, ...(lifecycleGrant === undefined ? {} : { lifecycleGrant }) };
    } });
  }
  async inspectBinding(ctx: CallContext, attachment: EnvironmentAttachment): Promise<Observation<BindingObservation>> {
    this.#store.recordCall("execution", "execution.inspectBinding", json(attachment));
    const stored = this.#store.getAttachment(attachment.attachmentRef.id);
    const associated = stored !== undefined && sameNativeRef(stored.attachmentRef, attachment.attachmentRef) && sameIdentity(stored.identity, attachment.identity);
    const resourceId = stored?.identity.native.id ?? attachment.identity.native.id;
    const state = this.#store.getEnvironment(resourceId);
    const identity = identityFor(resourceId, ctx.installationId, state.assurance, state.incarnation);
    const matches = sameIdentity(attachment.identity, identity);
    const active = associated && stored.detached === false;
    const limitations = !associated ? ["attachment_mismatch"] : stored.detached ? ["attachment_detached"] : matches ? [] : ["identity_replaced"];
    return { value: { identity, state: state.state, attachmentValid: active && matches && state.state === "running", grantValid: active && matches, knownExternalActivity: state.externalActivity, limitations }, sourceInstallationId: ctx.installationId, observedAt: this.#store.now(), assurance: "authoritative", limitations: [] };
  }
  async lookupOperation(_ctx: CallContext, operationId: Id): Promise<OperationLookup> { return this.#store.lookup(operationId); }
  async cancelOperation(ctx: ActionContext, operationIdToCancel: Id): Promise<OperationReceipt<{ readonly cancellationConfirmed: boolean }>> { return executeOperation(this.#store, ctx, { connector: "execution", kind: "execution.cancelOperation", resultSchemaId: "workhub.execution.cancellation.v1", resultSchema: CancellationResultSchema, input: { operationIdToCancel }, evidenceEffect: "operation.cancellation_confirmed", effect: () => ({ cancellationConfirmed: true }) }); }
  async detachAttachment(ctx: ActionContext, input: { readonly attachmentRef: NativeRef; readonly expectedIdentity: ResourceIdentity }): Promise<OperationReceipt<{ readonly detached: true }>> {
    const stored = this.#store.getAttachment(input.attachmentRef.id);
    if (stored === undefined || !sameNativeRef(stored.attachmentRef, input.attachmentRef) || !sameIdentity(stored.identity, input.expectedIdentity)) return rejected(ctx, "execution.detachAttachment", "workhub.execution.detached.v1", { code: "attachment_mismatch", category: "identity_mismatch", message: "The attachment reference is not associated with the expected resource identity.", retry: "never" });
    return executeOperation(this.#store, ctx, { connector: "execution", kind: "execution.detachAttachment", resultSchemaId: "workhub.execution.detached.v1", resultSchema: DetachedResultSchema, input: json(input), evidenceEffect: "binding.detached", effect: () => {
      this.#store.detachAttachment(input.attachmentRef.id);
      return { detached: true };
    } });
  }
  async releaseAllocation(ctx: ActionContext, input: AllocationRelease): Promise<OperationReceipt<ReleaseResult>> {
    if (input.lifecycleGrant.expiresAt !== undefined && this.#store.isExpired(input.lifecycleGrant.expiresAt)) return rejected(ctx, "execution.releaseAllocation", "workhub.execution.release.v1", { code: "lifecycle_grant_expired", category: "authorization", message: "The lifecycle grant expired before the provider received the release request.", retry: "never" });
    const issued = this.#store.getAllocation(input.allocationRef.id);
    const authorityMatches = issued !== undefined && sameNativeRef(issued.allocationRef, input.allocationRef) && sameIdentity(issued.identity, input.expectedIdentity) && sameLifecycleGrant(issued.lifecycleGrant, input.lifecycleGrant) && issued.lifecycleGrant.releasePolicyRef === input.releasePolicyRef;
    if (!authorityMatches || !input.lifecycleGrant.allowedActions.includes("release_allocation")) return rejected(ctx, "execution.releaseAllocation", "workhub.execution.release.v1", { code: "release_not_granted", category: "authorization", message: "The lifecycle grant does not authorize release of this allocation identity and policy.", retry: "never" });
    return executeOperation(this.#store, ctx, { connector: "execution", kind: "execution.releaseAllocation", resultSchemaId: "workhub.execution.release.v1", resultSchema: ReleaseResultSchema, input: json(input), evidenceEffect: "allocation.release_policy_applied", effect: () => {
      const configured = this.#store.getState(`release:${input.allocationRef.id}`);
      const result = configured !== undefined
        ? SimulatedReleaseResultSchema.parse(JSON.parse(configured))
        : input.releasePolicyRef.includes("retain")
          ? { disposition: "retained" as const, referenceAvailability: "preserved" as const }
          : input.releasePolicyRef.includes("stop")
            ? { disposition: "stopped" as const, referenceAvailability: "may_expire" as const }
            : input.releasePolicyRef.includes("delete")
              ? { disposition: "deleted" as const, referenceAvailability: "may_expire" as const }
              : { disposition: "provider_managed" as const, referenceAvailability: "unknown" as const };
      const observedState = ({ retained: undefined, stopped: "stopped", deleted: "missing", provider_managed: undefined } as const)[result.disposition];
      if (observedState !== undefined) this.#store.setEnvironment(input.allocationRef.id, { ...this.#store.getEnvironment(input.allocationRef.id), state: observedState });
      return result;
    } });
  }
  #constructAllocation(ctx: ActionContext, input: AllocationRequest): AllocationDescriptor {
    const allocationRef = { installationId: ctx.installationId, providerScope: "simulated", kind: "allocation", id: `allocation:${input.attemptId}`, incarnation: "v1" };
    const identity = identityFor(allocationRef.id, ctx.installationId, "immutable", "v1");
    const lifecycleGrant: LifecycleGrant = { id: `lifecycle:${allocationRef.id}`, allocationRef, releasePolicyRef: input.releasePolicyRef, allowedActions: ["release_allocation", "cancel_preparation"] };
    const allocation: AllocationDescriptor = { allocationRef, identity, lifecycleGrant, ready: true };
    this.#store.setEnvironment(allocationRef.id, { state: "running", assurance: "immutable", externalActivity: "idle", incarnation: "v1" });
    this.#store.putAllocation(allocation);
    return allocation;
  }
}
