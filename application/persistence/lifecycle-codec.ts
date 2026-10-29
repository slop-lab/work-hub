import { z } from "zod";

export const criterionRowSchema = z.strictObject({
  id: z.string(), taskId: z.string(), amendmentId: z.string(), key: z.string(),
  description: z.string(), requirement: z.enum(["required", "optional"]),
  verification: z.enum(["required", "optional"]),
  supersededByCriterionId: z.string().nullable(), createdAt: z.string(),
});

export const amendmentRowSchema = z.strictObject({
  id: z.string(), taskId: z.string(), revision: z.number(), authorId: z.string(),
  summary: z.string(), supersedesJson: z.string(), createdAt: z.string(),
});

export const acceptanceRowSchema = z.strictObject({
  id: z.string(), taskId: z.string(), resultId: z.string(), actorId: z.string(),
  decision: z.enum(["accepted", "incomplete", "rejected"]),
  missingCriteriaJson: z.string(), note: z.string().nullable(), createdAt: z.string(),
});

export const blockerRowSchema = z.strictObject({
  id: z.string(), taskId: z.string(), attemptId: z.string().nullable(),
  kind: z.enum(["environment", "permission", "external_dependency", "task_dependency",
    "capacity", "provider_unknown", "child_work"]), owner: z.string(), remedy: z.string(),
  detail: z.string(), status: z.enum(["open", "resolved", "rechecking"]),
  resolution: z.string().nullable(), recheckNote: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
