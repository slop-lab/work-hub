import { z } from "zod";
import { attemptSchema, idSchema as id, requestSchema, sessionSchema, taskSchema, timestampSchema as timestamp, userSchema } from "./schema-work.ts";

export type { HubAttempt, HubRequest, HubSession, HubTask } from "./schema-work.ts";

const workAreaSchema = z.object({
	key: id,
	path: z.string(),
	requestedAccess: z.enum(["read", "write"]),
});
const actionSchema = z.array(z.string());

export const resultSchema = z.object({
	id,
	attemptId: id,
	taskId: id,
	summary: z.string(),
	limitations: z.array(z.string()),
	referenceIds: z.array(id),
	submittedAt: timestamp,
});
export const environmentSchema = z.object({
	id,
	revision: z.number().int(),
	label: z.string(),
	executionInstallationId: id,
	verifiedAt: timestamp.optional(),
	identityAssurance: z.enum(["immutable", "attested", "weak"]).optional(),
	observedState: z.enum(["running", "stopped", "missing", "unknown"]).optional(),
	workAreas: z.array(workAreaSchema),
	limitations: z.array(z.string()),
	retiredAt: timestamp.optional(),
});
export const installationSchema = z.object({ id, label: z.string(), revision: z.number().int(), kind: z.enum(["execution", "agent_runtime"]), contractMajor: z.number().int(), enabled: z.boolean(), available: z.boolean(), simulator: z.boolean(), reason: z.string() });
export const referenceSchema = z.object({ id, taskId: id, kind: z.enum(["text", "link"]), title: z.string(), mimeType: z.string(), availability: z.string(), contentRevision: z.string().nullable(), createdAt: timestamp, retainedText: z.string().nullable().optional(), url: z.string().url().nullable().optional() });
export const bindingSchema = z.object({
	id,
	generation: z.number().int(),
	taskId: id.optional(),
	sessionId: id.optional(),
	origin: z.enum(["registered_existing", "allocated"]),
	state: z.enum(["requested", "waiting", "attached", "detaching", "detached", "releasing", "released", "failed"]),
	identityLabel: z.string(),
	access: z.enum(["read", "write"]),
	enforcement: z.enum(["enforced", "advisory", "unknown"]),
	canDetach: z.boolean(),
	canRelease: z.boolean(),
	limitations: z.array(z.string()),
});
export const profileSchema = z.object({
	id,
	revision: z.number().int(),
	label: z.string(),
	allowedEnvironmentModes: z.array(z.enum(["provision", "existing", "none"])),
	defaultEnvironmentMode: z.enum(["provision", "existing", "none"]),
	enabled: z.boolean(),
	limitations: z.array(z.string()),
	simulator: z.boolean(),
	runtimeInstallationId: id,
	configuration: z.record(z.string(), z.unknown()),
	defaultEnvironment: z.record(z.string(), z.unknown()),
	requiredCapabilities: z.array(z.string()),
	allowedEffects: z.array(z.string()),
});
const attentionItemSchema = z.object({
	key: id,
	kind: z.string(),
	title: z.string(),
	context: z.string(),
	taskId: id.optional(),
	sessionId: id.optional(),
	requestId: id.optional(),
	resultId: id.optional(),
	freshness: z.enum(["fresh", "stale", "unreachable", "unknown"]),
	reasonCode: z.string(),
	availableActions: actionSchema,
});
const outputSchema = z.object({
	id,
	sessionId: id,
	attemptId: id.optional(),
	kind: z.enum(["message", "log", "status_note", "reference", "gap"]),
	role: z.enum(["user", "agent", "runtime"]).optional(),
	text: z.string().optional(),
	partial: z.boolean().optional(),
	observedAt: timestamp,
});
const entrySchema = z.object({ id, taskId: id, authorId: id, kind: z.string(), text: z.string(), createdAt: timestamp });
const answerValueSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("text"), text: z.string() }), z.object({ kind: z.literal("single_choice"), optionId: z.string() }), z.object({ kind: z.literal("approval"), decision: z.enum(["approve", "deny"]), note: z.string().optional() })]);
const responseSchema = z.object({ id, requestId: id, requestRevision: z.number().int(), authorId: id, answer: answerValueSchema, digest: z.string(), committedAt: timestamp });
const viewStateSchema = z.object({ attentionKey: z.string(), readAt: timestamp.nullable().optional(), dismissedAt: timestamp.nullable().optional() });

export const hubStateSchema = z.object({
	snapshotCursor: z.string(),
	generatedAt: timestamp,
	simulator: z.boolean(),
	limitations: z.array(z.string()),
	me: userSchema,
	projects: z.array(z.object({ id, revision: z.number().int(), name: z.string(), defaultProfileId: id.optional() })),
	users: z.array(userSchema),
	tasks: z.array(taskSchema),
	requests: z.array(requestSchema),
	sessions: z.array(sessionSchema),
	attempts: z.array(attemptSchema),
	results: z.array(resultSchema),
	environments: z.array(environmentSchema),
	environmentBindings: z.array(bindingSchema),
	profiles: z.array(profileSchema),
	installations: z.array(installationSchema),
	references: z.array(referenceSchema).default([]),
	attention: z.object({
		answerNeeded: z.array(attentionItemSchema),
		approvalNeeded: z.array(attentionItemSchema),
		responseDelivery: z.array(attentionItemSchema),
		activeWork: z.array(attentionItemSchema),
		resultReview: z.array(attentionItemSchema),
		operationalIssues: z.array(attentionItemSchema),
	}),
	entries: z.array(entrySchema).default([]),
	responses: z.array(responseSchema).default([]),
	userViewState: z.array(viewStateSchema).default([]),
	output: z.array(outputSchema),
});

export const commandReceiptSchema = z.object({
	commandId: id,
	actorId: id,
	status: z.enum(["accepted", "running", "confirmed", "rejected", "failed", "unknown"]),
	confirmedEffect: z.string().optional(),
	objectRefs: z.array(z.object({ kind: z.string(), id, revision: z.number().int().optional() })),
	operationIds: z.array(id),
	error: z.object({ code: z.string(), message: z.string(), retry: z.string() }).optional(),
});

export type HubState = z.infer<typeof hubStateSchema>;
export type HubResult = z.infer<typeof resultSchema>;
export type HubEnvironment = z.infer<typeof environmentSchema>;
export type HubBinding = z.infer<typeof bindingSchema>;
export type HubProfile = z.infer<typeof profileSchema>;
export type HubReference = z.infer<typeof referenceSchema>;
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

export const outputPageSchema = z.object({ items: z.array(outputSchema), nextCursor: z.string().optional(), coverage: z.enum(["complete_available", "partial", "live_only"]), gaps: z.array(z.object({ reason: z.string() })), retainedBounds: z.object({ first: z.number().nullable(), last: z.number().nullable(), count: z.number().int(), gapCount: z.number().int() }) });
export type OutputPage = z.infer<typeof outputPageSchema>;
