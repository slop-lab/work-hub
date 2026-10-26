import { z } from 'zod';
import type { HubSnapshot } from '../domain/model.ts';
import { answerValueSchema } from '../domain/schema-common.ts';

const entryRow = z.object({ id: z.string(), taskId: z.string(), authorId: z.string(), entryType: z.string(), bodyJson: z.string(), createdAt: z.string() });
const responseRow = z.object({ id: z.string(), requestId: z.string(), requestRevision: z.number(), authorId: z.string(), answerJson: z.string(), answerDigest: z.string(), committedAt: z.string() });
const outputRow = z.object({ id: z.string(), sessionId: z.string(), attemptId: z.string().nullable(), itemJson: z.string(), createdAt: z.string() });
const operationRow = z.object({ id: z.string(), commandId: z.string(), connectorKind: z.enum(['execution', 'runtime']), installationId: z.string(), operationKind: z.string(), stage: z.string(), targetId: z.string().nullable(), targetGeneration: z.number().nullable(), status: z.enum(['accepted', 'running', 'confirmed', 'rejected', 'failed', 'unknown']), receiptJson: z.string().nullable(), updatedAt: z.string() });
const operationReceipt = z.object({ operationKind: z.string().optional(), error: z.object({ code: z.string(), message: z.string(), retry: z.string() }).optional(), reconciliationHint: z.string().optional(), evidence: z.object({ observedAt: z.string() }).optional() }).passthrough();
const outputItem = z.object({ kind: z.enum(['message', 'log', 'status_note', 'reference', 'gap']), role: z.enum(['user', 'agent', 'runtime']).optional(), text: z.string().optional(), partial: z.boolean().optional(), observedAt: z.string() });

export function presentOutput(raw: Readonly<Record<string, unknown>>) {
  const row = outputRow.parse(raw);
  const sequence = z.object({ localSequence: z.number() }).parse(raw).localSequence;
  return { id: row.id, sessionId: row.sessionId, sequence, ...(row.attemptId ? { attemptId: row.attemptId } : {}), ...outputItem.parse(JSON.parse(row.itemJson)) };
}

export function presentOperation(raw: Readonly<Record<string, unknown>>) {
  const row = operationRow.parse(raw);
  const receipt = row.receiptJson === null ? undefined : operationReceipt.safeParse(JSON.parse(row.receiptJson));
  const detail = receipt?.success === true ? receipt.data : undefined;
  return { id: row.id, commandId: row.commandId, connectorKind: row.connectorKind, installationId: row.installationId,
    operationKind: row.operationKind, ...(detail?.operationKind === undefined ? {} : { providerOperationKind: detail.operationKind }), stage: row.stage, ...(row.targetId === null ? {} : { targetId: row.targetId }), ...(row.targetGeneration === null ? {} : { targetGeneration: row.targetGeneration }), status: row.status,
    updatedAt: row.updatedAt, observedAt: detail?.evidence?.observedAt ?? row.updatedAt, ...(detail?.error === undefined ? {} : { error: detail.error }), ...(detail?.reconciliationHint === undefined ? {} : { reconciliationHint: detail.reconciliationHint }), canReconcile: row.status === 'unknown' && detail?.error?.retry === 'reconcile_first' };
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
    operations: (snapshot.operations ?? []).map(presentOperation),
  };
}
