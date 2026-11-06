import { z } from "zod";
import type { NativeRef, RuntimeEvent } from "../contracts/index.ts";
import { JsonValueSchema, NativeRefSchema, RecipientSchema } from "../contracts/index.ts";
import type { SimulatorStore } from "./store.ts";
import type { SimulatedExecutionConnector } from "./execution.ts";
import { SimulatedQuestionSchema, SimulatedReadinessSchema, SimulatedReleaseResultSchema, SimulatedResultSchema, SimulatedSessionSeedSchema, SimulatedTerminationSchema, type SimulatedQuestion, type SimulatedResult, type SimulatedTermination, type SimulatorControls } from "./types.ts";

const SessionControlStateSchema = z.object({ nativeSession: NativeRefSchema, controlGrantId: z.string(), phase: z.string() }).passthrough();
const EventBaseShape = { sourceEventId: z.string(), sourceCursor: z.string(), streamScope: z.string(), nativeSession: NativeRefSchema, bindingGeneration: z.number().int(), observedAt: z.string() };
export const SimulatedAdminEventSchema = z.discriminatedUnion("adminKind", [
  z.strictObject({ ...EventBaseShape, adminKind: z.literal("question"), requestId: z.string(), attemptId: z.string(), projectId: z.string(), taskId: z.string().optional(), recipient: RecipientSchema, controlGrantRef: z.string(), prompt: z.string(), responseRoute: z.enum(["native", "bridge"]), blocking: z.enum(["none", "runtime_action"]) }),
  z.strictObject({ ...EventBaseShape, adminKind: z.literal("result"), attemptId: z.string(), summary: z.string(), referenceIds: z.array(z.string()) }),
  z.strictObject({ ...EventBaseShape, adminKind: z.literal("termination"), attemptId: z.string().optional(), termination: z.enum(["completed", "stopped", "failed", "unknown"]) }),
]);
type SimulatedAdminEvent = z.infer<typeof SimulatedAdminEventSchema>;
type PendingAdminEvent = SimulatedAdminEvent extends infer Event ? Event extends SimulatedAdminEvent ? Omit<Event, "sourceEventId" | "sourceCursor"> : never : never;

export class PersistentSimulatorControls implements SimulatorControls {
  readonly #store: SimulatorStore;
  readonly #execution: SimulatedExecutionConnector;
  constructor(store: SimulatorStore, execution: SimulatedExecutionConnector) { this.#store = store; this.#execution = execution; }
  #session(sessionId: string): { readonly nativeSession: NativeRef; readonly controlGrantId: string; readonly state: z.infer<typeof SessionControlStateSchema> } {
    const raw = this.#store.getState(`session:${sessionId}`);
    const state = SessionControlStateSchema.parse(raw === undefined ? { nativeSession: { installationId: "sim-runtime", providerScope: "simulated", kind: "agent-session", id: `native:${sessionId}`, incarnation: "v1" }, controlGrantId: `control:${sessionId}`, phase: "idle" } : JSON.parse(raw));
    return { nativeSession: state.nativeSession, controlGrantId: state.controlGrantId, state };
  }
  #record(sessionId: string, event: PendingAdminEvent): void {
    const parsed = SimulatedAdminEventSchema.parse({ ...event, sourceEventId: "pending", sourceCursor: "pending" });
    this.#store.addEvent(sessionId, JsonValueSchema.parse(JSON.parse(JSON.stringify(parsed))));
  }
  scriptNext(operationKind: string, outcome: Parameters<SimulatorControls["scriptNext"]>[1]): void { this.#store.scriptNext(operationKind, outcome); }
  completeAllocation(operationId: string): void { this.#execution.completeAllocation(operationId); }
  setEnvironment(registrationId: string, state: Parameters<SimulatorControls["setEnvironment"]>[1]): void { this.#store.setEnvironment(registrationId, state); }
  setRuntimeProfile(profile: Parameters<SimulatorControls["setRuntimeProfile"]>[0]): void { this.#store.setRuntimeProfile(profile); }
  setSessionMissing(hubSessionId: string): void { const session = this.#session(hubSessionId); this.#store.setState(`session:${hubSessionId}`, JSON.stringify({ ...session.state, missing: true })); }
  setDeliveryLookupAvailable(hubSessionId: string, available: boolean): void { this.#store.setState(`response-lookup:${z.string().min(1).parse(hubSessionId)}`, available ? "available" : "held"); }
  addHistoryGap(hubSessionId: string, reason: string): void { this.#store.setState(`gap:${hubSessionId}`, reason); }
  emitOutput(hubSessionId: string, text: string, hubAttemptId?: string): void { const value = z.string().max(65_536).parse(text); this.#store.addOutput(hubSessionId, { kind: "message", role: "agent", text: value, observedAt: this.#store.now(), ...(hubAttemptId === undefined ? {} : { hubAttemptId }) }); }
  emitQuestion(input: SimulatedQuestion): void {
    const value = SimulatedQuestionSchema.parse(input); const session = this.#session(value.hubSessionId); const observedAt = this.#store.now();
    this.#record(value.hubSessionId, { adminKind: "question", streamScope: value.hubSessionId, nativeSession: session.nativeSession, bindingGeneration: value.bindingGeneration, observedAt, requestId: value.requestId, attemptId: value.hubAttemptId, projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }), recipient: value.recipient, controlGrantRef: session.controlGrantId, prompt: value.prompt, responseRoute: value.responseRoute, blocking: value.blocking });
  }
  emitResult(input: SimulatedResult): void {
    const value = SimulatedResultSchema.parse(input); const session = this.#session(value.hubSessionId);
    this.#record(value.hubSessionId, { adminKind: "result", streamScope: value.hubSessionId, nativeSession: session.nativeSession, bindingGeneration: value.bindingGeneration, observedAt: this.#store.now(), attemptId: value.hubAttemptId, summary: value.summary, referenceIds: value.referenceIds });
  }
  emitTermination(input: SimulatedTermination): void {
    const value = SimulatedTerminationSchema.parse(input); const session = this.#session(value.hubSessionId);
    this.#store.setState(`session:${value.hubSessionId}`, JSON.stringify({ ...session.state, phase: "ended", termination: value.termination, ...(value.hubAttemptId === undefined ? {} : { attemptId: value.hubAttemptId }) }));
    this.#record(value.hubSessionId, { adminKind: "termination", streamScope: value.hubSessionId, nativeSession: session.nativeSession, bindingGeneration: value.bindingGeneration, observedAt: this.#store.now(), ...(value.hubAttemptId === undefined ? {} : { attemptId: value.hubAttemptId }), termination: value.termination });
  }
  seedSession(input: Parameters<SimulatorControls["seedSession"]>[0]): void {
    const value = SimulatedSessionSeedSchema.parse(input);
    const nativeSession = value.nativeSession ?? { installationId: "sim-runtime", providerScope: "simulated", kind: "agent-session", id: `native:${value.hubSessionId}`, incarnation: "v1" };
    this.#store.setState(`session:${value.hubSessionId}`, JSON.stringify({ nativeSession, controlGrantId: `control:${value.hubSessionId}`, mode: value.controlMode, phase: value.phase, history: value.history ?? "partial", missing: false, ...(value.hubAttemptId === undefined ? {} : { attemptId: value.hubAttemptId }), ...(value.nativeExecutionRef === undefined ? {} : { nativeExecutionRef: value.nativeExecutionRef }) }));
  }
  setRuntimeReadiness(routeId: string, readiness: Parameters<SimulatorControls["setRuntimeReadiness"]>[1]): void { this.#store.setState(`readiness:${routeId}`, JSON.stringify(SimulatedReadinessSchema.parse(readiness))); }
  setReleaseResult(allocationId: string, result: Parameters<SimulatorControls["setReleaseResult"]>[1]): void { this.#store.setState(`release:${allocationId}`, JSON.stringify(SimulatedReleaseResultSchema.parse(result))); }
}

export function toRuntimeEvent(value: unknown, sequence?: number): RuntimeEvent {
  const event = SimulatedAdminEventSchema.parse(value);
  const cursor = sequence === undefined ? event.sourceCursor : String(sequence);
  const base = { sourceEventId: cursor, sourceCursor: cursor, streamScope: event.streamScope, nativeSession: event.nativeSession, bindingGeneration: event.bindingGeneration, observedAt: event.observedAt };
  switch (event.adminKind) {
    case "question": return { ...base, payload: { type: "request.created", request: {
      nativeRequestRef: { installationId: event.nativeSession.installationId, providerScope: event.nativeSession.providerScope, kind: "request", id: event.requestId, incarnation: event.nativeSession.incarnation },
      draft: { kind: "question", projectId: event.projectId, ...(event.taskId === undefined ? {} : { taskId: event.taskId }), recipient: event.recipient, prompt: event.prompt, referenceIds: [], answerSchema: { kind: "text", minLength: 1, maxLength: 131_072 }, blocking: event.blocking,
        validity: { kind: "attempt", target: { hubSessionId: event.streamScope, hubAttemptId: event.attemptId, nativeSession: event.nativeSession, bindingGeneration: event.bindingGeneration, controlGrantRef: event.controlGrantRef } } }, responseRoute: event.responseRoute } } };
    case "result": return { ...base, payload: { type: "result.submitted", attemptId: event.attemptId, summary: event.summary, referenceIds: event.referenceIds } };
    case "termination": return { ...base, payload: { type: "execution.observed", observation: { ...(event.attemptId === undefined ? {} : { hubAttemptId: event.attemptId }), phase: "ended", termination: event.termination, pendingNativeRequestRefs: [] } } };
  }
}
