import { z } from "zod";

import { envelope, idSchema, textSchema } from "./schema-common.ts";
import { referenceInput } from '../artifacts/references.ts';

export const workCommandSchemas = [
  envelope('reference.create', referenceInput),
  envelope(
    "task.create",
    z.strictObject({
      projectId: idSchema,
      title: z.string().trim().min(1).max(4096),
      description: textSchema.optional(),
      expectedOutcome: textSchema.optional(),
      priority: z.number().int().min(0).max(100).optional(),
      ownerId: idSchema.optional(),
    }),
  ),
  envelope(
    "task.update",
    z.strictObject({
      title: z.string().trim().min(1).max(4096).optional(),
      description: textSchema.optional(),
      expectedOutcome: textSchema.optional(),
      priority: z.number().int().min(0).max(100).nullable().optional(),
      ownerId: idSchema.nullable().optional(),
    }),
  ),
  envelope(
    "task.comment",
    z.strictObject({ text: textSchema.min(1), referenceIds: z.array(idSchema).default([]) }),
  ),
  envelope(
    "task.setStatus",
    z.strictObject({
      status: z.union([
        z.literal("backlog"),
        z.literal("active"),
        z.literal("review"),
        z.literal("done"),
        z.literal("canceled"),
      ]),
      activeExecutionDecision: z
        .union([z.literal("request_stop"), z.literal("allow_to_continue")])
        .optional(),
      completionNote: textSchema.optional(),
      resultId: idSchema.optional(),
    }),
  ),
  envelope("task.archive", z.strictObject({ reason: textSchema.optional() })),
  envelope(
    "task.requestRevision",
    z.discriminatedUnion("path", [
      z.strictObject({
        resultId: idSchema,
        sessionId: idSchema,
        instruction: textSchema.min(1),
        path: z.literal("instruction"),
        mode: z.union([z.literal("immediate"), z.literal("runtime_queued")]).default("immediate"),
      }),
      z.strictObject({
        resultId: idSchema,
        sessionId: idSchema,
        instruction: textSchema.min(1),
        path: z.literal("continuation"),
        profileId: idSchema,
        context: z.union([z.literal("snapshot"), z.literal("current_task")]),
        environmentReuse: z.union([z.literal("reuse"), z.literal("reattach")]),
      }),
    ]),
  ),
  envelope(
    "result.submit",
    z.strictObject({
      summary: textSchema.min(1),
      limitations: z.array(textSchema),
      referenceIds: z.array(idSchema),
      evidence: z.array(
        z.strictObject({
          origin: z.union([
            z.literal("agent_claim"),
            z.literal("runtime_observation"),
            z.literal("external_check"),
            z.literal("human_assertion"),
          ]),
          detail: textSchema,
        }),
      ),
    }),
  ),
] as const;
