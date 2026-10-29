import { z } from "zod";

export const idSchema = z.string().min(1);
export const timestampSchema = z.string().min(1);

export const userSchema = z.object({
	id: idSchema,
	displayName: z.string(),
	role: z.enum(["admin", "member"]),
	enabled: z.boolean().optional(),
	revision: z.number().int().optional(),
	projectIds: z.array(idSchema).optional(),
	profileIds: z.array(idSchema).optional(),
	bindingIds: z.array(idSchema).optional(),
});

export const taskSchema = z.object({
	id: idSchema,
	revision: z.number().int(),
	scopeRevision: z.number().int().nonnegative().default(0),
	projectId: idSchema,
	title: z.string(),
	description: z.string(),
	expectedOutcome: z.string().optional(),
	status: z.enum(["backlog", "active", "review", "done", "canceled"]),
	priority: z.enum(["low", "medium", "high", "urgent"]),
	ownerId: idSchema.optional(),
	updatedAt: timestampSchema,
	primaryAttemptId: idSchema.optional(),
	archivedAt: timestampSchema.optional(),
});

const answerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("text"), minLength: z.number().int(), maxLength: z.number().int() }),
	z.object({ kind: z.literal("single_choice"), options: z.array(z.object({ id: idSchema, label: z.string() })) }),
	z.object({ kind: z.literal("approval"), allowed: z.tuple([z.literal("approve"), z.literal("deny")]) }),
]);

export const requestSchema = z.object({
	id: idSchema,
	revision: z.number().int(),
	kind: z.enum(["question", "approval"]),
	status: z.enum(["open", "answered", "withdrawn", "expired", "superseded"]),
	taskId: idSchema.optional(),
	sessionId: idSchema.optional(),
	attemptId: idSchema.optional(),
	bindingGeneration: z.number().int().positive().optional(),
	recipient: z.discriminatedUnion("kind", [z.object({ kind: z.literal("user"), userId: idSchema }), z.object({ kind: z.literal("project_members"), projectId: idSchema }), z.object({ kind: z.literal("agent_session"), sessionId: idSchema })]),
	prompt: z.string(),
	reason: z.string().optional(),
	answerSchema,
	blocking: z.enum(["none", "before_delegate", "runtime_action"]),
	responseRoute: z.enum(["none", "native", "bridge"]).optional(),
	deliveryStatus: z.enum(["not_required", "pending", "acknowledged", "rejected", "unknown", "suppressed"]).optional(),
	updatedAt: timestampSchema,
});

export const sessionSchema = z.object({
	id: idSchema,
	revision: z.number().int(),
	taskId: idSchema,
	state: z.enum(["opening", "open", "closed"]),
	controlMode: z.enum(["view", "observe", "control"]),
	runtimeLabel: z.string(),
	profileId: idSchema.optional(),
	activeAttemptId: idSchema.optional(),
	bindingGeneration: z.number().int(),
	capabilities: z.object({
		instructionModes: z.array(z.enum(["immediate", "runtime_queued"])),
		stopModes: z.array(z.string()),
		canContinue: z.boolean(),
		nativeQuestionSupport: z.boolean().default(false),
		bridgeQuestionSupport: z.boolean().default(false),
	}),
	limitations: z.array(z.string()),
});

export const attemptSchema = z.object({
	id: idSchema,
	taskId: idSchema,
	sessionId: idSchema,
	profileId: idSchema,
	profileRevision: z.number().int(),
	phase: z.enum(["queued", "preparing", "opening_session", "observing", "running", "waiting_input", "finished"]),
	outcome: z.enum(["result_submitted", "failed", "canceled", "ended_without_result"]).optional(),
	observation: z.enum(["fresh", "stale", "unreachable", "unknown"]),
	inputSnapshot: z.record(z.string(), z.unknown()).default({}),
	predecessorId: idSchema.optional(),
	unresolved: z.boolean().default(false),
	retryOrdinal: z.number().int().nonnegative().default(0),
	retryLimit: z.number().int().nonnegative().default(0),
	origin: z.string(),
	role: z.enum(["primary", "observed"]),
	stopRequestedAt: timestampSchema.optional(),
	updatedAt: timestampSchema,
});

export type HubTask = z.infer<typeof taskSchema>;
export type HubRequest = z.infer<typeof requestSchema>;
export type HubSession = z.infer<typeof sessionSchema>;
export type HubAttempt = z.infer<typeof attemptSchema>;
