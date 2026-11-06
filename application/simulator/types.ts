import { z } from "zod";
import type { AgentRuntimeConnector, ExecutionConnector, JsonObject } from "../contracts/index.ts";
import { NativeRefSchema, RecipientSchema } from "../contracts/index.ts";

export type RuntimeProfile = "structured" | "limited_bridge";
export type ScriptedOutcome =
  | { readonly kind: "accepted_waiting"; readonly progress?: string | undefined }
  | { readonly kind: "unknown_after_effect" }
  | { readonly kind: "definite_failure"; readonly code?: string | undefined }
  | { readonly kind: "partial_release" };

export type SimulatedEnvironment = {
  readonly state: "running" | "stopped" | "missing" | "unknown";
  readonly assurance: "immutable" | "attested" | "weak";
  readonly externalActivity: "idle" | "active" | "unknown";
  readonly incarnation: string;
};

export type SimulatorCall = {
  readonly sequence: number;
  readonly connector: "execution" | "runtime";
  readonly operationKind: string;
  readonly operationId?: string;
  readonly inputDigest?: string;
  readonly input: JsonObject;
  readonly recordedAt: string;
};

export const SimulatedQuestionSchema = z.strictObject({
  hubSessionId: z.string().min(1), hubAttemptId: z.string().min(1), requestId: z.string().min(1),
  projectId: z.string().min(1), taskId: z.string().min(1).optional(), recipient: RecipientSchema,
  bindingGeneration: z.number().int().positive(), prompt: z.string().min(1).max(131_072), responseRoute: z.enum(["native", "bridge"]),
  blocking: z.enum(["none", "runtime_action"]),
});
export type SimulatedQuestion = z.infer<typeof SimulatedQuestionSchema>;

export const SimulatedResultSchema = z.strictObject({
  hubSessionId: z.string().min(1), hubAttemptId: z.string().min(1), summary: z.string().min(1),
  bindingGeneration: z.number().int().positive(), referenceIds: z.array(z.string()),
});
export type SimulatedResult = z.infer<typeof SimulatedResultSchema>;

export const SimulatedTerminationSchema = z.strictObject({
  hubSessionId: z.string().min(1), hubAttemptId: z.string().min(1).optional(),
  bindingGeneration: z.number().int().positive(), termination: z.enum(["completed", "stopped", "failed", "unknown"]),
});
export type SimulatedTermination = z.infer<typeof SimulatedTerminationSchema>;

export const SimulatedSessionSeedSchema = z.strictObject({
  hubSessionId: z.string().min(1), nativeSession: NativeRefSchema.optional(), controlMode: z.enum(["observe", "control"]),
  phase: z.enum(["idle", "running", "waiting_input", "ended", "unknown"]), hubAttemptId: z.string().optional(),
  nativeExecutionRef: NativeRefSchema.optional(),
  history: z.enum(["complete_available", "partial", "live_only", "unavailable"]).optional(),
});
export type SimulatedSessionSeed = z.infer<typeof SimulatedSessionSeedSchema>;
export const SimulatedReadinessSchema = z.strictObject({ ready: z.boolean(), unmetRequirements: z.array(z.string()) });
export type SimulatedReadiness = z.infer<typeof SimulatedReadinessSchema>;
export const SimulatedReleaseResultSchema = z.strictObject({ disposition: z.enum(["retained", "stopped", "deleted", "provider_managed"]), referenceAvailability: z.enum(["preserved", "may_expire", "unknown"]) });
export type SimulatedReleaseResult = z.infer<typeof SimulatedReleaseResultSchema>;

export interface SimulatorControls {
  scriptNext(operationKind: string, outcome: ScriptedOutcome): void;
  completeAllocation(operationId: string): void;
  setEnvironment(registrationId: string, state: SimulatedEnvironment): void;
  setRuntimeProfile(profile: RuntimeProfile): void;
  setSessionMissing(hubSessionId: string): void;
  setDeliveryLookupAvailable(hubSessionId: string, available: boolean): void;
  addHistoryGap(hubSessionId: string, reason: string): void;
  emitOutput(hubSessionId: string, text: string, hubAttemptId?: string): void;
  emitQuestion(input: SimulatedQuestion): void;
  emitResult(input: SimulatedResult): void;
  emitTermination(input: SimulatedTermination): void;
  seedSession(input: SimulatedSessionSeed): void;
  setRuntimeReadiness(routeId: string, readiness: SimulatedReadiness): void;
  setReleaseResult(allocationId: string, result: SimulatedReleaseResult): void;
}

export interface SimulatorCallLog { list(): readonly SimulatorCall[] }
export interface Simulators {
  readonly execution: ExecutionConnector;
  readonly runtime: AgentRuntimeConnector;
  runtimeFor(profile: RuntimeProfile): AgentRuntimeConnector;
  readonly controls: SimulatorControls;
  readonly calls: SimulatorCallLog;
  close(): void;
}
