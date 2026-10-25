import { z } from "zod";
import { RequestValiditySchema } from '../contracts/index.ts';

import {
  answerSchemaSchema,
  answerValueSchema,
  envelope,
  idSchema,
  jsonObjectSchema,
  recipientSchema,
  textSchema,
} from "./schema-common.ts";


export const interactionCommandSchemas = [
  envelope(
    "request.create",
    z.strictObject({
      kind: z.union([z.literal("question"), z.literal("approval")]),
      projectId: idSchema,
      taskId: idSchema.optional(),
      sessionId: idSchema.optional(),
      attemptId: idSchema.optional(),
      bindingGeneration: z.number().int().positive().optional(),
      recipient: recipientSchema,
      prompt: textSchema.min(1),
      reason: textSchema.optional(),
      referenceIds: z.array(idSchema),
      answerSchema: answerSchemaSchema,
      blocking: z.union([
        z.literal("none"),
        z.literal("before_delegate"),
        z.literal("runtime_action"),
      ]),
      validity: RequestValiditySchema,
      actionDescription: jsonObjectSchema.optional(),
      supersedesRequestId: idSchema.optional(),
      responseRoute: z.union([z.literal("none"), z.literal("native"), z.literal("bridge")]).default("none"),
    }),
  ),
  envelope("request.respond", z.strictObject({ answer: answerValueSchema })),
  envelope("request.withdraw", z.strictObject({ reason: textSchema.min(1) })),
  envelope("request.reassign", z.strictObject({ recipient: recipientSchema })),
  envelope(
    "bridge.response.ack",
    z.strictObject({
      responseId: idSchema,
      responseDigest: z.string().min(1).max(512),
      bindingGeneration: z.number().int().positive(),
    }),
  ),
] as const;
