import { z } from "zod";

import { envelope, idSchema, textSchema } from "./schema-common.ts";
import { referenceInput } from '../artifacts/references.ts';
import { SourceCommitSchema, VerificationOutcomeSchema } from "../contracts/handoff.ts";
import { DigestSchema } from "../contracts/common.ts";

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
      kind: z.enum(["checkpoint", "final"]).default("final"),
      submissionKey: z.string().trim().min(1).max(512).optional(),
      outcome: VerificationOutcomeSchema.default("unspecified"),
      inputDigest: DigestSchema.optional(),
      actualCommit: SourceCommitSchema.optional(),
      actualContextDigest: DigestSchema.optional(),
      summary: textSchema.min(1),
      limitations: z.array(textSchema),
      referenceIds: z.array(idSchema),
      artifacts: z.array(z.strictObject({
        repositoryId: idSchema, sourceCommit: SourceCommitSchema,
        path: z.string().min(1).max(4096), digest: DigestSchema.optional(),
      })).max(100).default([]),
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
      criterionEvidence: z.array(z.strictObject({
        criterionId: idSchema,
        status: z.enum(["satisfied", "not_satisfied", "not_verified"]),
        detail: textSchema.min(1),
        referenceIds: z.array(idSchema).max(100).default([]),
      })).max(100).default([]),
    }),
  ),
] as const;
