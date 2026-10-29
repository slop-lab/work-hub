import { z } from "zod";

import { envelope, idSchema, textSchema } from "./schema-common.ts";

const criterionInputSchema = z.strictObject({
  key: idSchema,
  description: textSchema.min(1),
  requirement: z.enum(["required", "optional"]),
  verification: z.enum(["required", "optional"]),
});

export const lifecycleCommandSchemas = [
  envelope("task.amend", z.strictObject({
    summary: textSchema.min(1),
    criteria: z.array(criterionInputSchema).min(1).max(100),
    supersedesCriterionIds: z.array(idSchema).max(100).default([]),
  })),
  envelope("task.acceptResult", z.strictObject({
    resultId: idSchema,
    decision: z.enum(["accepted", "incomplete", "rejected"]),
    missingCriteria: z.array(idSchema).max(100).default([]),
    note: textSchema.optional(),
  })),
  envelope("blocker.open", z.strictObject({
    attemptId: idSchema.optional(),
    kind: z.enum(["environment", "permission", "external_dependency", "task_dependency",
      "capacity", "provider_unknown", "child_work"]),
    owner: textSchema.min(1),
    remedy: textSchema.min(1),
    detail: textSchema.min(1),
  })),
  envelope("blocker.resolve", z.strictObject({ resolution: textSchema.min(1) })),
  envelope("blocker.recheck", z.strictObject({ note: textSchema.min(1) })),
  envelope("attempt.reconcile", z.strictObject({
    interruption: z.enum(["paused", "awaiting_input", "provider_stop", "operator_stop",
      "retryable_failure", "crash", "unknown"]),
    recovery: z.enum(["observe", "reconcile"]),
    note: textSchema.min(1),
  })),
  envelope("attempt.controlledResume", z.strictObject({
    recovery: z.enum(["resume", "retry", "escalated"]),
    reason: textSchema.min(1),
    retryLimit: z.number().int().min(0).max(20),
  })),
] as const;
