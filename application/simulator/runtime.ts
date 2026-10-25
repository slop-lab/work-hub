import { z } from "zod";
import type { AccessHandleRef, ActionContext, AgentRuntimeConnector, AttemptStart, CallContext, ConnectorManifest, Id, InputReceipt, InstructionInput, JsonObject, Observation, OpenSessionInput, OperationLookup, OperationReceipt, OutputItem, OutputPage, ResponseDelivery, RuntimeBindingDescriptor, RuntimeCapabilities, RuntimeControlGrant, RuntimeEvent, RuntimePreparation, RuntimeRoute, RuntimeSessionObservation, RuntimeTarget, StopInput, StopResult } from "../contracts/index.ts";
import { InputReceiptSchema, JsonObjectSchema, NativeRefSchema, OutputItemSchema, ResponseDeliveryResultSchema, RuntimeBindingDescriptorSchema, RuntimeControlGrantSchema, RuntimeDetachedResultSchema, RuntimeRouteResultSchema, StopResultSchema } from "../contracts/index.ts";
import { executeOperation, rejected } from "./operation.ts";
import { toRuntimeEvent } from "./controls.ts";
import type { SimulatorStore } from "./store.ts";
import { SimulatedReadinessSchema } from "./types.ts";

const json = (value: unknown): JsonObject => JsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
const capability = (support: "supported" | "unsupported" | "unknown", implementation: "native" | "bridge" | "connector", limitations: readonly string[] = []) => ({ support, implementation, limitations: [...limitations] });
const SessionStateSchema = z.strictObject({ nativeSession: NativeRefSchema, controlGrantId: z.string(), mode: z.enum(["observe", "control"]), phase: z.enum(["idle", "running", "waiting_input", "ended", "unknown"]), history: z.enum(["complete_available", "partial", "live_only", "unavailable"]), missing: z.boolean(), attemptId: z.string().optional(), termination: z.enum(["completed", "stopped", "failed", "unknown"]).optional() });
type SessionState = z.infer<typeof SessionStateSchema>;

const structuredCapabilities = (): RuntimeCapabilities => ({ servicePreparation: capability("supported", "connector"), controlTransfer: capability("supported", "native"), createSession: capability("supported", "native"), attachSession: capability("supported", "native"), structuredInput: capability("supported", "native"), structuredOutput: capability("supported", "native"), nativeQuestions: capability("supported", "native"), requestBridge: capability("supported", "bridge"), nativeApprovals: capability("supported", "native"), continueNativeSession: capability("supported", "native"), outputReplay: capability("supported", "native"), stableNativeIdentity: capability("supported", "native"), resultReporting: capability("supported", "native"), activeInputModes: ["immediate", "runtime_queued"], stopModes: ["interrupt", "stop_work", "terminate_session_process"], stopObservation: "process_termination", surfaces: ["transcript", "terminal", "native_view"], configurationSchemaId: "workhub.simulator.runtime.structured.v1" });
const limitedCapabilities = (): RuntimeCapabilities => ({ servicePreparation: capability("unsupported", "connector", ["externally_prepared_only"]), controlTransfer: capability("unsupported", "connector"), createSession: capability("supported", "connector"), attachSession: capability("supported", "connector"), structuredInput: capability("supported", "bridge"), structuredOutput: capability("supported", "bridge"), nativeQuestions: capability("unsupported", "connector"), requestBridge: capability("supported", "bridge"), nativeApprovals: capability("unsupported", "connector", ["no_trustworthy_native_mapping"]), continueNativeSession: capability("unsupported", "connector"), outputReplay: capability("unsupported", "connector", ["live_only"]), stableNativeIdentity: capability("unknown", "connector", ["weak_identity"]), resultReporting: capability("supported", "bridge"), activeInputModes: ["runtime_queued"], stopModes: ["interrupt"], stopObservation: "request_only", surfaces: ["transcript"], configurationSchemaId: "workhub.simulator.runtime.limited-bridge.v1" });

export class SimulatedRuntimeConnector implements AgentRuntimeConnector {
  readonly #store: SimulatorStore;
  constructor(store: SimulatorStore) { this.#store = store; }
  #capabilities(): RuntimeCapabilities { return this.#store.getRuntimeProfile() === "structured" ? structuredCapabilities() : limitedCapabilities(); }
  #state(sessionId: string): SessionState | undefined { const raw = this.#store.getState(`session:${sessionId}`); return raw === undefined ? undefined : SessionStateSchema.parse(JSON.parse(raw)); }
  #save(sessionId: string, state: SessionState): void { this.#store.setState(`session:${sessionId}`, JSON.stringify(state)); }
  #sameNative(left: import("../contracts/index.ts").NativeRef, right: import("../contracts/index.ts").NativeRef): boolean { return left.installationId === right.installationId && left.providerScope === right.providerScope && left.kind === right.kind && left.id === right.id && left.incarnation === right.incarnation; }
  #targetError(target: RuntimeTarget, attemptId?: string): import("../contracts/index.ts").ConnectorError | undefined {
    const state = this.#state(target.hubSessionId);
    if (state === undefined || state.missing) return { code: "session_missing", category: "unavailable", message: "The native session is missing.", retry: "manual_action" };
    if (!this.#sameNative(state.nativeSession, target.nativeSession)) return { code: "native_identity_mismatch", category: "identity_mismatch", message: "The native session identity does not match the binding.", retry: "manual_action" };
    if (state.controlGrantId !== target.controlGrantRef) return { code: "control_grant_invalid", category: "authorization", message: "The runtime control grant is not current.", retry: "never" };
    if (attemptId !== undefined && state.attemptId !== attemptId) return { code: "attempt_target_mismatch", category: "conflict", message: "The target is not the active native execution.", retry: "reconcile_first" };
    return undefined;
  }
  describe(): { readonly manifest: ConnectorManifest; readonly capabilities: RuntimeCapabilities } {
    const safety = { deduplicatesByClientOperationId: true, lookupByClientOperationId: true, replayAfterUnknown: "same_id_only" as const };
    return { manifest: { id: "workhub.simulator.runtime", kind: "agent_runtime", implementationVersion: "0.3.0", contractMajor: 1, configurationSchemaId: this.#capabilities().configurationSchemaId, requiredSecretPurposes: [], requiredPermissions: [], operationSafety: { prepareRuntime: safety, openSession: safety, requestControl: safety, startAttempt: safety, sendInstruction: safety, deliverResponse: safety, requestStop: safety, detachSession: safety }, extensions: { simulated: true, profile: this.#store.getRuntimeProfile() } }, capabilities: this.#capabilities() };
  }
  async probe(ctx: CallContext, route: RuntimeRoute): Promise<Observation<{ readonly ready: boolean; readonly unmetRequirements: readonly string[] }>> { this.#store.recordCall("runtime", "runtime.probe", json(route)); const configured = this.#store.getState(`readiness:${route.route.id}`); const value = configured === undefined ? { ready: true, unmetRequirements: [] } : SimulatedReadinessSchema.parse(JSON.parse(configured)); return { value, sourceInstallationId: ctx.installationId, observedAt: this.#store.now(), assurance: "reported", limitations: [] }; }
  async prepareRuntime(ctx: ActionContext, input: RuntimePreparation): Promise<OperationReceipt<{ readonly route: AccessHandleRef }>> {
    if (this.#store.getRuntimeProfile() === "limited_bridge") return rejected(ctx, "runtime.prepareRuntime", "workhub.runtime.route.v1", { code: "service_preparation_unsupported", category: "unsupported", message: "This runtime must be prepared externally.", retry: "manual_action" });
    return executeOperation(this.#store, ctx, { connector: "runtime", kind: "runtime.prepareRuntime", resultSchemaId: "workhub.runtime.route.v1", resultSchema: RuntimeRouteResultSchema, input: json(input), evidenceEffect: "runtime.service_ready", effect: () => ({ route: input.route.route }) });
  }
  async openSession(ctx: ActionContext, input: OpenSessionInput): Promise<OperationReceipt<RuntimeBindingDescriptor>> {
    const seeded = this.#state(input.hubSessionId);
    if (input.mode === "attach" && seeded !== undefined && !this.#sameNative(seeded.nativeSession, input.nativeSession)) return rejected(ctx, "runtime.openSession", "workhub.runtime.binding.v1", { code: "native_identity_mismatch", category: "identity_mismatch", message: "The seeded native session has a different identity.", retry: "manual_action" });
    return executeOperation<RuntimeBindingDescriptor>(this.#store, ctx, { connector: "runtime", kind: "runtime.openSession", resultSchemaId: "workhub.runtime.binding.v1", resultSchema: RuntimeBindingDescriptorSchema, input: json(input), evidenceEffect: "session.opened", effect: () => {
      const profile = this.#store.getRuntimeProfile();
      const nativeSession = input.mode === "attach" ? input.nativeSession : { installationId: ctx.installationId, providerScope: "simulated", kind: "agent-session", id: `native:${input.hubSessionId}`, incarnation: "v1" };
      const mode = input.requestedControl;
      const allowedActions: RuntimeControlGrant["allowedActions"] = mode === "observe" ? [] : profile === "structured" ? ["start_attempt", "send_instruction", "deliver_response", "request_stop", "interactive_input"] : ["start_attempt", "send_instruction", "deliver_response", "request_stop"];
      const controlGrant = { id: `control:${input.hubSessionId}`, mode, allowedActions, externalClientsMayAlsoControl: input.mode === "attach" };
      const history = seeded?.history ?? (profile === "structured" ? "complete_available" as const : "live_only" as const);
      this.#save(input.hubSessionId, { ...(seeded ?? { phase: "idle" as const }), nativeSession, controlGrantId: controlGrant.id, mode, history, missing: false });
      return { nativeSession, nativeIdentityAssurance: profile === "structured" ? "immutable" as const : "weak" as const, origin: input.mode === "attach" ? "attached_existing" as const : "created" as const, route: input.route.route, controlGrant, capabilities: this.#capabilities(), history };
    } });
  }
  async requestControl(ctx: ActionContext, input: { readonly target: RuntimeTarget; readonly requestedActions: RuntimeControlGrant["allowedActions"] }): Promise<OperationReceipt<RuntimeControlGrant>> {
    if (this.#store.getRuntimeProfile() === "limited_bridge") return rejected(ctx, "runtime.requestControl", "workhub.runtime.control-grant.v1", { code: "control_transfer_unsupported", category: "unsupported", message: "This profile cannot transfer native control.", retry: "never" });
    const error = this.#targetError(input.target);
    if (error !== undefined) return rejected(ctx, "runtime.requestControl", "workhub.runtime.control-grant.v1", error);
    return executeOperation<RuntimeControlGrant>(this.#store, ctx, { connector: "runtime", kind: "runtime.requestControl", resultSchemaId: "workhub.runtime.control-grant.v1", resultSchema: RuntimeControlGrantSchema, input: json(input), evidenceEffect: "runtime.control_granted", effect: () => { const grant = { id: `control:${input.target.hubSessionId}:transferred`, mode: "control" as const, allowedActions: [...input.requestedActions], externalClientsMayAlsoControl: true }; const state = this.#state(input.target.hubSessionId); if (state !== undefined) this.#save(input.target.hubSessionId, { ...state, mode: "control", controlGrantId: grant.id }); return grant; } });
  }
  async startAttempt(ctx: ActionContext, input: AttemptStart): Promise<OperationReceipt<InputReceipt>> {
    const state = this.#state(input.target.hubSessionId);
    const targetError = this.#targetError(input.target);
    if (targetError !== undefined) return rejected(ctx, "runtime.startAttempt", "workhub.runtime.input-receipt.v1", targetError);
    if (state === undefined) return rejected(ctx, "runtime.startAttempt", "workhub.runtime.input-receipt.v1", { code: "session_missing", category: "unavailable", message: "The native session is missing.", retry: "manual_action" });
    if (state.mode !== "control") return rejected(ctx, "runtime.startAttempt", "workhub.runtime.input-receipt.v1", { code: "control_required", category: "authorization", message: "Observe-only bindings cannot start attempts.", retry: "never" });
    if (state.attemptId !== undefined && state.phase !== "ended") return rejected(ctx, "runtime.startAttempt", "workhub.runtime.input-receipt.v1", { code: "attempt_already_active", category: "conflict", message: "A native execution is already active.", retry: "reconcile_first" });
    return executeOperation<InputReceipt>(this.#store, ctx, { connector: "runtime", kind: "runtime.startAttempt", resultSchemaId: "workhub.runtime.input-receipt.v1", resultSchema: InputReceiptSchema, input: json(input), evidenceEffect: "attempt.input_received", effect: () => { const nativeExecutionRef = { installationId: ctx.installationId, providerScope: "simulated", kind: "execution", id: `execution:${input.target.hubAttemptId}`, incarnation: "v1" }; this.#save(input.target.hubSessionId, { ...state, phase: "running", attemptId: input.target.hubAttemptId }); return { nativeInputRef: { ...nativeExecutionRef, kind: "input", id: `input:${input.input.id}` }, nativeExecutionRef, acceptance: "received" }; } });
  }
  async sendInstruction(ctx: ActionContext, input: InstructionInput): Promise<OperationReceipt<InputReceipt>> {
    const state = this.#state(input.target.hubSessionId);
    const targetError = this.#targetError(input.target, input.target.hubAttemptId);
    if (targetError !== undefined) return rejected(ctx, "runtime.sendInstruction", "workhub.runtime.input-receipt.v1", targetError);
    if (state?.mode !== "control") return rejected(ctx, "runtime.sendInstruction", "workhub.runtime.input-receipt.v1", { code: "control_required", category: "authorization", message: "Observe-only bindings cannot send instructions.", retry: "never" });
    if (!this.#capabilities().activeInputModes.includes(input.mode)) return rejected(ctx, "runtime.sendInstruction", "workhub.runtime.input-receipt.v1", { code: "input_mode_unsupported", category: "unsupported", message: "The requested delivery timing is unsupported.", retry: "never" });
    return executeOperation<InputReceipt>(this.#store, ctx, { connector: "runtime", kind: "runtime.sendInstruction", resultSchemaId: "workhub.runtime.input-receipt.v1", resultSchema: InputReceiptSchema, input: json(input), evidenceEffect: "instruction.accepted_by_runtime", effect: () => ({ nativeInputRef: { installationId: ctx.installationId, providerScope: "simulated", kind: "input", id: `instruction:${ctx.operationId}` }, acceptance: input.mode === "runtime_queued" ? "queued" : "received" }) });
  }
  async deliverResponse(ctx: ActionContext, input: ResponseDelivery): Promise<OperationReceipt<{ readonly responseId: Id; readonly receiptRef?: import("../contracts/index.ts").NativeRef | undefined }>> { const error = this.#targetError(input.target, input.target.hubAttemptId); if (error !== undefined) return rejected(ctx, "runtime.deliverResponse", "workhub.runtime.response-receipt.v1", error); return executeOperation(this.#store, ctx, { connector: "runtime", kind: "runtime.deliverResponse", resultSchemaId: "workhub.runtime.response-receipt.v1", resultSchema: ResponseDeliveryResultSchema, input: json(input), evidenceEffect: "response.acknowledged", effect: () => ({ responseId: input.responseId, receiptRef: { installationId: ctx.installationId, providerScope: "simulated", kind: "response-receipt", id: input.responseId } }) }); }
  async requestStop(ctx: ActionContext, input: StopInput): Promise<OperationReceipt<StopResult>> {
    const state = this.#state(input.target.hubSessionId);
    const targetError = this.#targetError(input.target, input.target.hubAttemptId);
    if (targetError !== undefined) return rejected(ctx, "runtime.requestStop", "workhub.runtime.stop-result.v1", targetError);
    if (state?.mode !== "control") return rejected(ctx, "runtime.requestStop", "workhub.runtime.stop-result.v1", { code: "control_required", category: "authorization", message: "Observe-only bindings cannot stop work.", retry: "never" });
    if (!this.#capabilities().stopModes.includes(input.mode)) return rejected(ctx, "runtime.requestStop", "workhub.runtime.stop-result.v1", { code: "stop_mode_unsupported", category: "unsupported", message: "The requested stop mode is unsupported.", retry: "never" });
    return executeOperation(this.#store, ctx, { connector: "runtime", kind: "runtime.requestStop", resultSchemaId: "workhub.runtime.stop-result.v1", resultSchema: StopResultSchema, input: json(input), evidenceEffect: "attempt.termination_observed", effect: () => { const confirmed = this.#capabilities().stopObservation !== "request_only"; this.#save(input.target.hubSessionId, { ...state, phase: confirmed ? "ended" : state.phase, ...(confirmed ? { termination: "stopped" as const } : {}) }); return { effect: confirmed ? "work_termination_confirmed" : "request_accepted" }; } });
  }
  async inspectSession(ctx: CallContext, target: RuntimeTarget): Promise<Observation<RuntimeSessionObservation>> {
    this.#store.recordCall("runtime", "runtime.inspectSession", json(target));
    const state = this.#state(target.hubSessionId);
    const missing = state === undefined || state.missing;
    const nativeSession = state?.nativeSession ?? target.nativeSession;
    const execution = { phase: missing ? "unknown" as const : state.phase, ...(state?.attemptId === undefined ? {} : { hubAttemptId: state.attemptId }), ...(state?.termination === undefined ? {} : { termination: state.termination }), pendingNativeRequestRefs: [] };
    return { value: { nativeSession, exists: missing ? false : true, execution, controlGrantValid: missing ? false : target.controlGrantRef === state.controlGrantId, ...(missing ? {} : { historyCursor: String(this.#store.lastStreamSequence(target.hubSessionId)) }), limitations: missing ? ["native_session_missing"] : [] }, sourceInstallationId: ctx.installationId, observedAt: this.#store.now(), assurance: "reported", limitations: [] };
  }
  async readOutput(_ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string; readonly limit: number }): Promise<OutputPage> {
    const after = z.coerce.number().int().nonnegative().parse(input.after ?? "0");
    const items = this.#store.readOutput(input.target.hubSessionId, after, Math.min(input.limit, 1_000)).map((row) => OutputItemSchema.parse({ ...JsonObjectSchema.parse(row.item), sourceItemId: String(row.sequence) }));
    const gap = this.#store.getState(`gap:${input.target.hubSessionId}`);
    const coverage = this.#store.getRuntimeProfile() === "structured" ? "complete_available" as const : "live_only" as const;
    const last = items.at(-1)?.sourceItemId;
    return { items, ...(last === undefined ? {} : { nextCursor: last }), coverage, gaps: gap === undefined ? [] : [{ reason: gap }] };
  }
  async *subscribe(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string }): AsyncIterable<RuntimeEvent> {
    const after = z.coerce.number().int().nonnegative().parse(input.after ?? "0");
    for (const row of this.#store.readStream(input.target.hubSessionId, after, 1_000)) {
      if (row.kind === "event") yield toRuntimeEvent(row.item, row.sequence);
      else {
        const item = OutputItemSchema.parse({ ...JsonObjectSchema.parse(row.item), sourceItemId: String(row.sequence) });
        yield { sourceEventId: String(row.sequence), sourceCursor: String(row.sequence), streamScope: input.target.hubSessionId, nativeSession: input.target.nativeSession, bindingGeneration: input.target.bindingGeneration, observedAt: item.observedAt, payload: { type: "output", item } };
      }
    }
    const gap = this.#store.getState(`gap:${input.target.hubSessionId}`);
    if (gap !== undefined) yield { streamScope: input.target.hubSessionId, nativeSession: input.target.nativeSession, bindingGeneration: input.target.bindingGeneration, observedAt: this.#store.now(), payload: { type: "gap", reason: gap } };
  }
  async detachSession(ctx: ActionContext, target: RuntimeTarget): Promise<OperationReceipt<{ readonly detached: true }>> { return executeOperation(this.#store, ctx, { connector: "runtime", kind: "runtime.detachSession", resultSchemaId: "workhub.runtime.detached.v1", resultSchema: RuntimeDetachedResultSchema, input: json(target), evidenceEffect: "session.detached", effect: () => ({ detached: true }) }); }
  async lookupOperation(_ctx: CallContext, operationId: Id): Promise<OperationLookup> { return this.#store.lookup(operationId); }
}
