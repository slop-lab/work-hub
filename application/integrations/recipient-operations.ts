import { z } from 'zod';
import { SourceCommitSchema, VerificationOutcomeSchema } from '../contracts/handoff.ts';
import { DigestSchema } from '../contracts/common.ts';

export const RecipientResultSchema = z.strictObject({
  submissionKey: z.string().min(1).max(200),
  kind: z.enum(['checkpoint', 'final']),
  sourceCommit: SourceCommitSchema,
  contextDigest: DigestSchema,
  outcome: VerificationOutcomeSchema,
  summary: z.string().min(1).max(32_768),
  limitations: z.array(z.string().max(8192)).max(50),
  referenceIds: z.array(z.string().min(1)).max(100),
  artifacts: z.array(z.strictObject({ repositoryId: z.string().min(1), sourceCommit: SourceCommitSchema,
    path: z.string().min(1).max(4096), digest: DigestSchema.optional() })).max(100),
  criterionEvidence: z.array(z.strictObject({ criterionId: z.string().min(1),
    status: z.enum(['satisfied', 'not_satisfied', 'not_verified']), detail: z.string().min(1).max(8192),
    referenceIds: z.array(z.string().min(1)).max(100) })).max(100),
  evidence: z.array(z.strictObject({ origin: z.literal('agent_claim'),
    detail: z.string().min(1).max(8192) })).max(100),
});
export const RecipientOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('assignment') }),
  z.strictObject({ kind: z.literal('ack'), deliveryDigest: DigestSchema }),
  z.strictObject({ kind: z.literal('result'), result: RecipientResultSchema }),
]);
export type RecipientOperation = z.infer<typeof RecipientOperationSchema>;
