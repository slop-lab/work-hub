import { z } from 'zod';

import { JsonObjectSchema } from '../../contracts/common.ts';
import { akbSourceReferenceSchema } from './schema.ts';
import { akbCandidateSchema, akbKnowledgeRelationSchema, akbKnowledgeSourceSchema } from './knowledge-schema.ts';

export const akbDocumentsResponseSchema = z.strictObject({
  items: z.array(akbSourceReferenceSchema.extend({ title: z.string(), lifecycle: z.literal('active') })).max(100),
  nextAfterId: z.string().max(200).nullable(),
  consistency: z.literal('live'),
});

export const akbContextItemSchema = akbSourceReferenceSchema.extend({
  schemaVersion: z.string().min(1),
  revisionCreatedAt: z.iso.datetime(),
  snapshot: JsonObjectSchema,
});

export const akbContextResponseSchema = z.strictObject({
  scope: z.literal('explicit-selection'),
  references: z.array(akbSourceReferenceSchema).min(1).max(25),
  selectionPage: z.strictObject({ id: z.string().min(1).max(200), revision: z.number().int().positive() }).nullable(),
  items: z.array(akbContextItemSchema).min(1).max(25),
  contentBytes: z.number().int().nonnegative().max(262144),
  maxBytes: z.number().int().positive().max(262144),
});

export type AkbDocumentsResponse = z.infer<typeof akbDocumentsResponseSchema>;
export type AkbContextResponse = z.infer<typeof akbContextResponseSchema>;

export const akbKnowledgeRevisionSchema = z.strictObject({
  id: z.string().min(1), revision: z.number().int().positive(), lifecycle: z.enum(['active', 'archived']),
  candidate: akbCandidateSchema, acceptedProposalId: z.string(), acceptedReviewId: z.string(),
  reviewedBy: z.string(), reviewedAt: z.iso.datetime(), sources: z.array(akbKnowledgeSourceSchema),
  relations: z.array(akbKnowledgeRelationSchema),
});
