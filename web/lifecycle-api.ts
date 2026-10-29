import ky, { HTTPError } from "ky";
import { z } from "zod";
import { ApiError } from "./api.ts";

const criterionSchema = z.object({
	id: z.string().min(1),
	taskId: z.string().min(1),
	amendmentId: z.string().min(1),
	key: z.string().min(1),
	description: z.string(),
	requirement: z.enum(["required", "optional"]),
	verification: z.enum(["required", "optional"]),
	supersededByCriterionId: z.string().min(1).optional(),
	createdAt: z.string().min(1),
});

const lifecycleSchema = z.object({
	taskId: z.string().min(1),
	scopeRevision: z.number().int().nonnegative(),
	amendments: z.array(z.object({
		id: z.string().min(1), taskId: z.string().min(1), revision: z.number().int().positive(),
		authorId: z.string().min(1), summary: z.string(), criteria: z.array(criterionSchema),
		supersedesCriterionIds: z.array(z.string()), createdAt: z.string().min(1),
	})),
	criteria: z.array(criterionSchema),
	acceptance: z.object({
		id: z.string().min(1), taskId: z.string().min(1), resultId: z.string().min(1), actorId: z.string().min(1),
		decision: z.enum(["accepted", "incomplete", "rejected"]), missingCriteria: z.array(z.string()),
		note: z.string().optional(), createdAt: z.string().min(1),
	}).optional(),
	blockers: z.array(z.object({
		id: z.string().min(1), taskId: z.string().min(1), attemptId: z.string().min(1).optional(),
		kind: z.enum(["environment", "permission", "external_dependency", "task_dependency", "capacity", "provider_unknown", "child_work"]),
		owner: z.string(), remedy: z.string(), detail: z.string(), status: z.enum(["open", "resolved", "rechecking"]),
		resolution: z.string().optional(), recheckNote: z.string().optional(), createdAt: z.string().min(1), updatedAt: z.string().min(1),
	})),
	attempts: z.array(z.object({
		id: z.string().min(1),
		interruption: z.enum(["paused", "awaiting_input", "provider_stop", "operator_stop", "retryable_failure", "crash", "unknown"]).optional(),
		recovery: z.enum(["none", "observe", "reconcile", "resume", "retry", "escalated"]),
		retry: z.object({ ordinal: z.number().int().nonnegative(), limit: z.number().int().nonnegative(), reason: z.string().optional() }),
	})),
	projection: z.object({
		currentMissingAction: z.enum(["delegate_or_submit", "await_execution", "recover_attempt", "resolve_blocker", "review_result", "revise_result", "none"]),
		responsibleOwner: z.string(), nextAction: z.string(),
		criterionCoverage: z.object({ required: z.number().int().nonnegative(), satisfied: z.number().int().nonnegative(), missing: z.array(z.string()) }),
		verificationRequired: z.boolean(), acceptanceMode: z.literal("human"),
	}),
});

export type TaskLifecycle = z.infer<typeof lifecycleSchema>;
export type LifecycleBlocker = TaskLifecycle["blockers"][number];
export type LifecycleAttempt = TaskLifecycle["attempts"][number];

const client = ky.create({ prefixUrl: "/api/v1", timeout: 15_000, retry: { limit: 1, methods: ["get"] }, credentials: "same-origin" });

export async function loadTaskLifecycle(taskId: string): Promise<TaskLifecycle> {
	try {
		return lifecycleSchema.parse(await client.get(`tasks/${encodeURIComponent(taskId)}/lifecycle`).json());
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, `Lifecycle request failed with status ${error.response.status}.`);
		throw error;
	}
}
