import { z } from "zod";
import type { AccessHandleRef, ActionContext, CallContext, Capability, ConnectorManifest, Cursor, Digest, Id, JsonObject, NativeRef, Observation, OperationLookup, OperationReceipt, Revision, Timestamp } from "./common.ts";
import { AccessHandleRefSchema, CapabilitySchema, DigestSchema, JsonObjectSchema, NativeRefSchema, TimestampSchema } from "./common.ts";
import type { EnvironmentAttachment, ResourceIdentity, WorkArea } from "./execution.ts";
import { EnvironmentAttachmentSchema, ResourceIdentitySchema, WorkAreaSchema } from "./execution.ts";
import { VerificationEnvelopeSchema, type VerificationEnvelope } from "./handoff.ts";

export interface RuntimeCapabilities {
  readonly servicePreparation: Capability; readonly controlTransfer: Capability; readonly createSession: Capability; readonly attachSession: Capability;
  readonly structuredInput: Capability; readonly structuredOutput: Capability; readonly nativeQuestions: Capability; readonly requestBridge: Capability;
  readonly nativeApprovals: Capability; readonly continueNativeSession: Capability; readonly outputReplay: Capability; readonly stableNativeIdentity: Capability;
  readonly resultReporting: Capability; readonly activeInputModes: readonly ("immediate" | "runtime_queued")[];
  readonly stopModes: readonly ("interrupt" | "stop_work" | "terminate_session_process")[];
  readonly stopObservation: "request_only" | "work_termination" | "process_termination";
  readonly surfaces: readonly ("transcript" | "terminal" | "native_view")[]; readonly configurationSchemaId: string;
}
export type RuntimeRoute = { readonly kind: "environment"; readonly attachment: EnvironmentAttachment; readonly route: AccessHandleRef } | { readonly kind: "external"; readonly route: AccessHandleRef };
export interface RuntimeControlGrant { readonly id: Id; readonly mode: "observe" | "control"; readonly allowedActions: readonly ("start_attempt" | "send_instruction" | "deliver_response" | "request_stop" | "interactive_input")[]; readonly expiresAt?: Timestamp | undefined; readonly externalClientsMayAlsoControl: boolean }
export interface RuntimeBindingDescriptor { readonly nativeSession: NativeRef; readonly nativeIdentityAssurance: "immutable" | "attested" | "weak"; readonly origin: "created" | "attached_existing" | "provider_precreated"; readonly route: AccessHandleRef; readonly controlGrant: RuntimeControlGrant; readonly capabilities: RuntimeCapabilities; readonly history: "complete_available" | "partial" | "live_only" | "unavailable" }
export type OpenSessionInput = { readonly hubSessionId: Id; readonly route: RuntimeRoute; readonly configuration: JsonObject; readonly requestedControl: "observe" | "control" } & ({ readonly mode: "create"; readonly sessionLaunchOwner: "runtime_connector" } | { readonly mode: "attach"; readonly nativeSession: NativeRef; readonly sessionLaunchOwner: "external" | "execution_provider" | "runtime_connector" });
export interface InputSnapshot {
  readonly id: Id; readonly digest: Digest; readonly taskId: Id; readonly taskRevision: Revision; readonly scopeRevision?: Revision; readonly profileId: Id; readonly profileRevision: Revision; readonly instruction: string; readonly selectedReferenceIds: readonly Id[]; readonly selectedResponseIds: readonly Id[];
  readonly contextItems: readonly { readonly sourceId: Id; readonly sourceRevision?: Revision; readonly includedText?: string; readonly retainedContentRef?: Id; readonly omissionReason?: string }[]; readonly authorizedEffectKinds: readonly string[]; readonly assembledAt: Timestamp;
  readonly verification?: VerificationEnvelope; readonly promptDigest?: Digest;
  readonly promptTemplate?: { readonly id: "task_brief" | "status_result" | "question_block" | "answer_continuation" | "verifier_handoff" | "fix_incomplete"; readonly version: number; readonly inputDigest: Digest } }
export interface RuntimeTarget { readonly hubSessionId: Id; readonly nativeSession: NativeRef; readonly bindingGeneration: number; readonly controlGrantRef: Id }
export interface AttemptTarget extends RuntimeTarget { readonly hubAttemptId: Id; readonly nativeExecutionRef?: NativeRef }
export interface AttemptStart { readonly target: AttemptTarget; readonly input: InputSnapshot; readonly workAreas: readonly WorkArea[]; readonly bridgeAccessHandle?: AccessHandleRef }
export interface InputReceipt { readonly nativeInputRef?: NativeRef | undefined; readonly nativeExecutionRef?: NativeRef | undefined; readonly acceptance: "received" | "queued" }
export interface InstructionInput { readonly target: AttemptTarget; readonly text: string; readonly referenceIds: readonly Id[]; readonly mode: "immediate" | "runtime_queued"; readonly promptTemplate?: InputSnapshot["promptTemplate"] }
export type AnswerSchema = { readonly kind: "text"; readonly minLength: number; readonly maxLength: number } | { readonly kind: "single_choice"; readonly options: readonly { readonly id: string; readonly label: string }[] } | { readonly kind: "approval"; readonly allowed: readonly ["approve", "deny"] };
export type Answer = { readonly kind: "text"; readonly text: string } | { readonly kind: "single_choice"; readonly optionId: string } | { readonly kind: "approval"; readonly decision: "approve" | "deny"; readonly note?: string };
export type Recipient = { readonly kind: "user"; readonly userId: Id } | { readonly kind: "project_members"; readonly projectId: Id } | { readonly kind: "agent_session"; readonly sessionId: Id };
export type RequestValidity = { readonly kind: "project"; readonly projectId: Id; readonly expiresAt?: Timestamp } | { readonly kind: "task"; readonly taskId: Id; readonly expiresAt?: Timestamp } | { readonly kind: "attempt"; readonly target: AttemptTarget; readonly expiresAt?: Timestamp; readonly nativeRequestRef?: NativeRef; readonly nativeRequestRevision?: string; readonly actionDigest?: Digest; readonly policyRevision?: string; readonly environmentIdentities?: readonly ResourceIdentity[] };
export interface RequestDraft { readonly kind: "question" | "approval"; readonly projectId: Id; readonly taskId?: Id; readonly recipient: Recipient; readonly prompt: string; readonly reason?: string; readonly referenceIds: readonly Id[]; readonly answerSchema: AnswerSchema; readonly blocking: "none" | "before_delegate" | "runtime_action"; readonly validity: RequestValidity; readonly actionDescription?: JsonObject; readonly supersedesRequestId?: Id }
export interface NativeRequestEvent { readonly nativeRequestRef: NativeRef; readonly nativeRequestRevision?: string; readonly draft: RequestDraft; readonly responseRoute: "native" | "bridge" }
export interface ResponseDelivery { readonly target: AttemptTarget; readonly requestId: Id; readonly requestRevision: Revision; readonly responseId: Id; readonly responseDigest: Digest; readonly nativeRequestRef: NativeRef; readonly answer: Answer; readonly validity: RequestValidity }
export interface ExecutionObservation { readonly nativeExecutionRef?: NativeRef; readonly hubAttemptId?: Id; readonly phase: "idle" | "running" | "waiting_input" | "ended" | "unknown"; readonly termination?: "completed" | "stopped" | "failed" | "unknown"; readonly startedAt?: Timestamp; readonly endedAt?: Timestamp; readonly pendingNativeRequestRefs: readonly NativeRef[] }
export type RuntimeActivityNode = {
  readonly nativeSession: NativeRef; readonly parentNativeSession?: NativeRef;
  readonly relation: "root" | "descendant";
  readonly phase: "idle" | "running" | "waiting_input" | "unknown";
};
export type RuntimeActivityObservation = {
  readonly coverage: "complete" | "partial" | "unknown";
  readonly nodes: readonly RuntimeActivityNode[]; readonly truncated: boolean;
};
export interface RuntimeSessionObservation { readonly nativeSession: NativeRef; readonly exists: boolean | "unknown"; readonly execution: ExecutionObservation; readonly controlGrantValid: boolean | "unknown"; readonly historyCursor?: Cursor; readonly limitations: readonly string[]; readonly activity?: RuntimeActivityObservation }
export const RuntimeActivityNodeSchema = z.strictObject({
  nativeSession: NativeRefSchema, parentNativeSession: NativeRefSchema.optional(),
  relation: z.enum(["root", "descendant"]),
  phase: z.enum(["idle", "running", "waiting_input", "unknown"]),
});
export const RuntimeActivityObservationSchema = z.strictObject({
  coverage: z.enum(["complete", "partial", "unknown"]),
  nodes: z.array(RuntimeActivityNodeSchema).max(32), truncated: z.boolean(),
});
export interface OutputItem { readonly sourceItemId?: string | undefined; readonly nativeExecutionRef?: NativeRef | undefined; readonly hubAttemptId?: Id | undefined; readonly kind: "message" | "log" | "status_note" | "reference" | "gap"; readonly role?: "user" | "agent" | "runtime" | undefined; readonly text?: string | undefined; readonly referenceId?: Id | undefined; readonly partial?: boolean | undefined; readonly observedAt: Timestamp; readonly extensions?: JsonObject | undefined }
export interface OutputPage { readonly items: readonly OutputItem[]; readonly nextCursor?: Cursor; readonly coverage: "complete_available" | "partial" | "live_only"; readonly gaps: readonly { readonly reason: string; readonly fromCursor?: Cursor; readonly toCursor?: Cursor }[] }
export type RuntimeEventPayload = { readonly type: "output"; readonly item: OutputItem } | { readonly type: "execution.observed"; readonly observation: ExecutionObservation } | { readonly type: "request.created"; readonly request: NativeRequestEvent }
  | { readonly type: "request.invalidated"; readonly nativeRequestRef: NativeRef; readonly reason: string } | { readonly type: "response.acknowledged"; readonly responseId: Id; readonly responseDigest: Digest } | { readonly type: "result.submitted"; readonly attemptId: Id; readonly summary: string; readonly referenceIds: readonly Id[] }
  | { readonly type: "gap"; readonly reason: string; readonly resumeCursor?: Cursor } | { readonly type: "extension"; readonly namespace: string; readonly data: JsonObject };
export interface RuntimeEvent { readonly sourceEventId?: string; readonly sourceCursor?: Cursor; readonly sourceSequence?: number; readonly streamScope: string; readonly nativeSession: NativeRef; readonly bindingGeneration: number; readonly observedAt: Timestamp; readonly payload: RuntimeEventPayload }
export interface StopInput { readonly target: AttemptTarget; readonly mode: "interrupt" | "stop_work" | "terminate_session_process"; readonly reason?: string }
export interface StopResult { readonly effect: "request_accepted" | "work_termination_confirmed" | "process_termination_confirmed" }
export interface RuntimePreparation { readonly route: RuntimeRoute; readonly launchOwner: "runtime_connector"; readonly configuration: JsonObject; readonly serviceLaunchGrantRef: Id; readonly allowedEffects: readonly string[] }

export const RuntimeCapabilitiesSchema = z.strictObject({ servicePreparation: CapabilitySchema, controlTransfer: CapabilitySchema, createSession: CapabilitySchema, attachSession: CapabilitySchema, structuredInput: CapabilitySchema, structuredOutput: CapabilitySchema, nativeQuestions: CapabilitySchema, requestBridge: CapabilitySchema, nativeApprovals: CapabilitySchema,
  continueNativeSession: CapabilitySchema, outputReplay: CapabilitySchema, stableNativeIdentity: CapabilitySchema, resultReporting: CapabilitySchema, activeInputModes: z.array(z.enum(["immediate", "runtime_queued"])), stopModes: z.array(z.enum(["interrupt", "stop_work", "terminate_session_process"])), stopObservation: z.enum(["request_only", "work_termination", "process_termination"]), surfaces: z.array(z.enum(["transcript", "terminal", "native_view"])), configurationSchemaId: z.string() });
export const RuntimeControlGrantSchema = z.strictObject({ id: z.string(), mode: z.enum(["observe", "control"]), allowedActions: z.array(z.enum(["start_attempt", "send_instruction", "deliver_response", "request_stop", "interactive_input"])), expiresAt: TimestampSchema.optional(), externalClientsMayAlsoControl: z.boolean() });
export const RuntimeBindingDescriptorSchema = z.strictObject({ nativeSession: NativeRefSchema, nativeIdentityAssurance: z.enum(["immutable", "attested", "weak"]), origin: z.enum(["created", "attached_existing", "provider_precreated"]), route: AccessHandleRefSchema, controlGrant: RuntimeControlGrantSchema, capabilities: RuntimeCapabilitiesSchema, history: z.enum(["complete_available", "partial", "live_only", "unavailable"]) });
export const RuntimeTargetSchema = z.strictObject({ hubSessionId: z.string(), nativeSession: NativeRefSchema, bindingGeneration: z.number().int().nonnegative(), controlGrantRef: z.string() });
export const AttemptTargetSchema = RuntimeTargetSchema.extend({ hubAttemptId: z.string(), nativeExecutionRef: NativeRefSchema.optional() }).strict();
export const RuntimeRouteSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("environment"), attachment: EnvironmentAttachmentSchema, route: AccessHandleRefSchema }), z.strictObject({ kind: z.literal("external"), route: AccessHandleRefSchema })]);
const OpenSessionBaseShape = { hubSessionId: z.string(), route: RuntimeRouteSchema, configuration: JsonObjectSchema, requestedControl: z.enum(["observe", "control"]) };
export const OpenSessionInputSchema = z.discriminatedUnion("mode", [z.strictObject({ ...OpenSessionBaseShape, mode: z.literal("create"), sessionLaunchOwner: z.literal("runtime_connector") }), z.strictObject({ ...OpenSessionBaseShape, mode: z.literal("attach"), nativeSession: NativeRefSchema, sessionLaunchOwner: z.enum(["external", "execution_provider", "runtime_connector"]) })]);
export const InputSnapshotSchema = z.strictObject({ id: z.string(), digest: DigestSchema, taskId: z.string(), taskRevision: z.number().int(), scopeRevision: z.number().int().default(0), profileId: z.string(), profileRevision: z.number().int(), instruction: z.string(), selectedReferenceIds: z.array(z.string()), selectedResponseIds: z.array(z.string()),
  contextItems: z.array(z.strictObject({ sourceId: z.string(), sourceRevision: z.number().int().optional(), includedText: z.string().optional(), retainedContentRef: z.string().optional(), omissionReason: z.string().optional() })), authorizedEffectKinds: z.array(z.string()), assembledAt: TimestampSchema,
  verification: VerificationEnvelopeSchema.optional(), promptDigest: DigestSchema.optional(),
  promptTemplate: z.strictObject({ id: z.enum(["task_brief", "status_result", "question_block", "answer_continuation", "verifier_handoff", "fix_incomplete"]), version: z.number().int().positive(), inputDigest: DigestSchema }).optional() });
export const AttemptStartSchema = z.strictObject({ target: AttemptTargetSchema, input: InputSnapshotSchema, workAreas: z.array(WorkAreaSchema), bridgeAccessHandle: AccessHandleRefSchema.optional() });
export const InstructionInputSchema = z.strictObject({ target: AttemptTargetSchema, text: z.string(), referenceIds: z.array(z.string()), mode: z.enum(["immediate", "runtime_queued"]), promptTemplate: InputSnapshotSchema.shape.promptTemplate.optional() });
export const InputReceiptSchema = z.strictObject({ nativeInputRef: NativeRefSchema.optional(), nativeExecutionRef: NativeRefSchema.optional(), acceptance: z.enum(["received", "queued"]) });
export const AnswerSchemaSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("text"), minLength: z.number().int().nonnegative(), maxLength: z.number().int().positive() }), z.strictObject({ kind: z.literal("single_choice"), options: z.array(z.strictObject({ id: z.string(), label: z.string() })) }), z.strictObject({ kind: z.literal("approval"), allowed: z.tuple([z.literal("approve"), z.literal("deny")]) })]);
export const AnswerValueSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("text"), text: z.string() }), z.strictObject({ kind: z.literal("single_choice"), optionId: z.string() }), z.strictObject({ kind: z.literal("approval"), decision: z.enum(["approve", "deny"]), note: z.string().optional() })]);
export const RecipientSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("user"), userId: z.string() }), z.strictObject({ kind: z.literal("project_members"), projectId: z.string() }), z.strictObject({ kind: z.literal("agent_session"), sessionId: z.string() })]);
export const RequestValiditySchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("project"), projectId: z.string(), expiresAt: TimestampSchema.optional() }), z.strictObject({ kind: z.literal("task"), taskId: z.string(), expiresAt: TimestampSchema.optional() }),
  z.strictObject({ kind: z.literal("attempt"), target: AttemptTargetSchema, expiresAt: TimestampSchema.optional(), nativeRequestRef: NativeRefSchema.optional(), nativeRequestRevision: z.string().optional(), actionDigest: DigestSchema.optional(), policyRevision: z.string().optional(), environmentIdentities: z.array(ResourceIdentitySchema).optional() })]);
export const RequestDraftSchema = z.strictObject({ kind: z.enum(["question", "approval"]), projectId: z.string(), taskId: z.string().optional(), recipient: RecipientSchema, prompt: z.string(), reason: z.string().optional(), referenceIds: z.array(z.string()), answerSchema: AnswerSchemaSchema, blocking: z.enum(["none", "before_delegate", "runtime_action"]), validity: RequestValiditySchema, actionDescription: JsonObjectSchema.optional(), supersedesRequestId: z.string().optional() });
export const NativeRequestEventSchema = z.strictObject({ nativeRequestRef: NativeRefSchema, nativeRequestRevision: z.string().optional(), draft: RequestDraftSchema, responseRoute: z.enum(["native", "bridge"]) });
export const ResponseDeliverySchema = z.strictObject({ target: AttemptTargetSchema, requestId: z.string(), requestRevision: z.number().int().nonnegative(), responseId: z.string(), responseDigest: DigestSchema, nativeRequestRef: NativeRefSchema, answer: AnswerValueSchema, validity: RequestValiditySchema });
export const ExecutionObservationSchema = z.strictObject({ nativeExecutionRef: NativeRefSchema.optional(), hubAttemptId: z.string().optional(), phase: z.enum(["idle", "running", "waiting_input", "ended", "unknown"]), termination: z.enum(["completed", "stopped", "failed", "unknown"]).optional(), startedAt: TimestampSchema.optional(), endedAt: TimestampSchema.optional(), pendingNativeRequestRefs: z.array(NativeRefSchema) });
export const RuntimeSessionObservationSchema = z.strictObject({ nativeSession: NativeRefSchema, exists: z.union([z.boolean(), z.literal("unknown")]), execution: ExecutionObservationSchema, controlGrantValid: z.union([z.boolean(), z.literal("unknown")]), historyCursor: z.string().optional(), limitations: z.array(z.string()), activity: RuntimeActivityObservationSchema.optional() });
export const OutputItemSchema = z.strictObject({ sourceItemId: z.string().optional(), nativeExecutionRef: NativeRefSchema.optional(), hubAttemptId: z.string().optional(), kind: z.enum(["message", "log", "status_note", "reference", "gap"]), role: z.enum(["user", "agent", "runtime"]).optional(), text: z.string().optional(), referenceId: z.string().optional(), partial: z.boolean().optional(), observedAt: TimestampSchema, extensions: JsonObjectSchema.optional() });
export const OutputPageSchema = z.strictObject({ items: z.array(OutputItemSchema), nextCursor: z.string().optional(), coverage: z.enum(["complete_available", "partial", "live_only"]), gaps: z.array(z.strictObject({ reason: z.string(), fromCursor: z.string().optional(), toCursor: z.string().optional() })) });
export const RuntimeEventPayloadSchema = z.discriminatedUnion("type", [z.strictObject({ type: z.literal("output"), item: OutputItemSchema }), z.strictObject({ type: z.literal("execution.observed"), observation: ExecutionObservationSchema }), z.strictObject({ type: z.literal("request.created"), request: NativeRequestEventSchema }),
  z.strictObject({ type: z.literal("request.invalidated"), nativeRequestRef: NativeRefSchema, reason: z.string() }), z.strictObject({ type: z.literal("response.acknowledged"), responseId: z.string(), responseDigest: DigestSchema }), z.strictObject({ type: z.literal("result.submitted"), attemptId: z.string(), summary: z.string(), referenceIds: z.array(z.string()) }),
  z.strictObject({ type: z.literal("gap"), reason: z.string(), resumeCursor: z.string().optional() }), z.strictObject({ type: z.literal("extension"), namespace: z.string(), data: JsonObjectSchema })]);
export const RuntimeEventSchema = z.strictObject({ sourceEventId: z.string().optional(), sourceCursor: z.string().optional(), sourceSequence: z.number().int().nonnegative().optional(), streamScope: z.string(), nativeSession: NativeRefSchema, bindingGeneration: z.number().int().nonnegative(), observedAt: TimestampSchema, payload: RuntimeEventPayloadSchema });
export const StopInputSchema = z.strictObject({ target: AttemptTargetSchema, mode: z.enum(["interrupt", "stop_work", "terminate_session_process"]), reason: z.string().optional() });
export const StopResultSchema = z.strictObject({ effect: z.enum(["request_accepted", "work_termination_confirmed", "process_termination_confirmed"]) });
export const RuntimePreparationSchema = z.strictObject({ route: RuntimeRouteSchema, launchOwner: z.literal("runtime_connector"), configuration: JsonObjectSchema, serviceLaunchGrantRef: z.string(), allowedEffects: z.array(z.string()) });
export const RuntimeProbeResultSchema = z.strictObject({ ready: z.boolean(), unmetRequirements: z.array(z.string()) });
export const RuntimeRouteResultSchema = z.strictObject({ route: AccessHandleRefSchema });
export const ResponseDeliveryResultSchema = z.strictObject({ responseId: z.string(), receiptRef: NativeRefSchema.optional() });
export const RuntimeDetachedResultSchema = z.strictObject({ detached: z.literal(true) });

export interface AgentRuntimeConnector {
  describe(): { readonly manifest: ConnectorManifest; readonly capabilities: RuntimeCapabilities };
  probe(ctx: CallContext, route: RuntimeRoute): Promise<Observation<{ readonly ready: boolean; readonly unmetRequirements: readonly string[] }>>;
  prepareRuntime?(ctx: ActionContext, input: RuntimePreparation): Promise<OperationReceipt<{ readonly route: AccessHandleRef }>>;
  openSession(ctx: ActionContext, input: OpenSessionInput): Promise<OperationReceipt<RuntimeBindingDescriptor>>;
  requestControl(ctx: ActionContext, input: { readonly target: RuntimeTarget; readonly requestedActions: RuntimeControlGrant["allowedActions"] }): Promise<OperationReceipt<RuntimeControlGrant>>;
  startAttempt(ctx: ActionContext, input: AttemptStart): Promise<OperationReceipt<InputReceipt>>;
  sendInstruction(ctx: ActionContext, input: InstructionInput): Promise<OperationReceipt<InputReceipt>>;
  deliverResponse(ctx: ActionContext, input: ResponseDelivery): Promise<OperationReceipt<{ readonly responseId: Id; readonly receiptRef?: NativeRef | undefined }>>;
  requestStop(ctx: ActionContext, input: StopInput): Promise<OperationReceipt<StopResult>>;
  inspectSession(ctx: CallContext, target: RuntimeTarget): Promise<Observation<RuntimeSessionObservation>>;
  readOutput(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: Cursor; readonly limit: number }): Promise<OutputPage>;
  subscribe?(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: Cursor }): AsyncIterable<RuntimeEvent>;
  detachSession(ctx: ActionContext, target: RuntimeTarget): Promise<OperationReceipt<{ readonly detached: true }>>;
  lookupOperation(ctx: CallContext, operationId: Id): Promise<OperationLookup>;
}
