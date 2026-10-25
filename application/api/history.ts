import { z } from 'zod';
import type { HubSnapshot } from '../domain/model.ts';
import { answerValueSchema } from '../domain/schema-common.ts';
import { exportSafeRecords } from '../artifacts/export.ts';

const entryRow = z.object({ id: z.string(), taskId: z.string(), authorId: z.string(), entryType: z.string(), bodyJson: z.string(), createdAt: z.string() });
const responseRow = z.object({ id: z.string(), requestId: z.string(), requestRevision: z.number(), authorId: z.string(), answerJson: z.string(), answerDigest: z.string(), committedAt: z.string() });
const outputRow = z.object({ id: z.string(), sessionId: z.string(), attemptId: z.string().nullable(), itemJson: z.string(), createdAt: z.string() });
const outputItem = z.object({ kind: z.enum(['message', 'log', 'status_note', 'reference', 'gap']), role: z.enum(['user', 'agent', 'runtime']).optional(), text: z.string().optional(), partial: z.boolean().optional(), observedAt: z.string() });

export function presentOutput(raw: Readonly<Record<string, unknown>>) {
  const row = outputRow.parse(raw);
  return { id: row.id, sessionId: row.sessionId, ...(row.attemptId ? { attemptId: row.attemptId } : {}), ...outputItem.parse(JSON.parse(row.itemJson)) };
}

export function presentHistory(snapshot: HubSnapshot) {
  return {
    entries: (snapshot.entries ?? []).map((raw) => {
      const row = entryRow.parse(raw);
      const body = z.object({ text: z.string().optional() }).parse(JSON.parse(row.bodyJson));
      return { id: row.id, taskId: row.taskId, authorId: row.authorId, kind: row.entryType, text: body.text ?? '', createdAt: row.createdAt };
    }),
    responses: (snapshot.responses ?? []).map((raw) => {
      const row = responseRow.parse(raw);
      return { id: row.id, requestId: row.requestId, requestRevision: row.requestRevision, authorId: row.authorId, answer: answerValueSchema.parse(JSON.parse(row.answerJson)), digest: row.answerDigest, committedAt: row.committedAt };
    }),
    output: (snapshot.output ?? []).map(presentOutput),
    references: snapshot.references ?? [],
    operations: (snapshot.operations ?? []).map((operation) => exportSafeRecords(operation)),
  };
}
