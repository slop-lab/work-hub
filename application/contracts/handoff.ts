import { z } from "zod";

import { DigestSchema } from "./common.ts";

export const SourceCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const VerificationOutcomeSchema = z.enum([
  "passed", "failed", "partial", "blocked", "unspecified",
]);
export const VerificationEnvelopeSchema = z.strictObject({
  repositoryId: z.string().min(1),
  repositoryRevision: z.number().int().positive(),
  sourceBranch: z.string().trim().min(1).max(1024),
  sourceCommit: SourceCommitSchema,
  requestedValidation: z.string().trim().min(1).max(32_768),
  contextDigest: DigestSchema,
});
export type VerificationEnvelope = z.infer<typeof VerificationEnvelopeSchema>;

export const HandoffRecipientSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("new") }),
  z.strictObject({
    kind: z.literal("attached"),
    sessionId: z.string().min(1),
    sessionRevision: z.number().int().positive(),
    bindingGeneration: z.number().int().positive(),
    profileId: z.string().min(1),
    profileRevision: z.number().int().positive(),
  }),
]);
export type HandoffRecipient = z.infer<typeof HandoffRecipientSchema>;

export const HandoffBindingSchema = z.strictObject({
  previewDigest: DigestSchema,
  verification: VerificationEnvelopeSchema,
  recipient: HandoffRecipientSchema,
});
export type HandoffBinding = z.infer<typeof HandoffBindingSchema>;

export const AttemptDeliveryStatusSchema = z.enum([
  "pending", "delivered", "acknowledged", "failed", "unknown",
]);
export type AttemptDeliveryStatus = z.infer<typeof AttemptDeliveryStatusSchema>;

export const RecipientIntegrationPromptSchema = z.strictObject({
  assignmentTool: z.literal("workhub_assignment"),
  acknowledgmentTool: z.literal("workhub_ack"),
  resultTool: z.literal("workhub_result"),
  assignmentReadRequired: z.literal(true),
  deliveryAcknowledgmentRequired: z.literal(true),
  humanAcceptanceSeparate: z.literal(true),
});
export type RecipientIntegrationPrompt = z.infer<typeof RecipientIntegrationPromptSchema>;
