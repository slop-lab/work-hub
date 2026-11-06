import { z } from 'zod';

const id = z.string().min(1).max(200).regex(/^[^/\\]+$/);
const title = z.string().min(1).max(500);
const text = z.string().max(50000);
const role = z.enum(['supporting', 'contradicting', 'context']);

export const akbCandidateSchema = z.discriminatedUnion('type', [
  z.strictObject({ title, type: z.literal('claim'), statement: text.min(1),
    status: z.enum(['proposed', 'accepted', 'disputed', 'rejected', 'superseded']),
    confidence: z.number().min(0).max(1), validityScope: z.string().max(10000) }),
  z.strictObject({ title, type: z.literal('decision'), decision: text.min(1), context: text,
    alternatives: text, rationale: text, consequences: text,
    status: z.enum(['proposed', 'accepted', 'superseded', 'reversed']), ownerId: id,
    reviewDate: z.iso.date().nullable(), appliesTo: z.string().max(10000) }),
  z.strictObject({ title, type: z.literal('evidence'), sourceType: z.enum(['entity', 'runtime_artifact', 'external']),
    sourceRef: id, observation: text.min(1), capturedAt: z.iso.datetime(), capturedBy: id,
    reliability: z.number().min(0).max(1), validity: z.string().max(10000) }),
  z.strictObject({ title, type: z.literal('question'), question: text.min(1),
    status: z.enum(['open', 'investigating', 'answered', 'abandoned']), ownerId: id,
    delegates: z.array(id).max(100), acceptedAnswerId: id.nullable() }),
  z.strictObject({ title, type: z.literal('experiment'), hypothesis: text.min(1), method: text.min(1),
    inputs: text, runs: text, results: text, conclusion: text }),
]);

export const akbKnowledgeSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('entity'), entityId: id, revision: z.number().int().positive(), role }),
  z.strictObject({ kind: z.literal('runtime_artifact'), artifactId: id, role }),
  z.strictObject({ kind: z.literal('external'), serviceInstanceId: id, resourceKind: id, resourceId: id,
    version: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('revision'), value: z.string().min(1).max(200) }),
      z.strictObject({ kind: z.literal('digest'), algorithm: z.literal('sha256'), value: z.string().regex(/^[a-f0-9]{64}$/) }),
    ]), permalink: z.url().max(2048), excerpt: text.optional(), role }),
]);

export const akbKnowledgeRelationSchema = z.strictObject({ entityId: id, revision: z.number().int().positive(),
  type: z.enum(['supports', 'contradicts', 'answers', 'supersedes', 'applies_to']) });
