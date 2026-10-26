import { DatabaseSync } from 'node:sqlite';
import { z, type ZodType } from 'zod';
import type { ActionContext, CallContext, OperationLookup, OperationReceipt, SerializedOperationReceipt } from '../contracts/index.ts';
import { JsonValueSchema, SerializedOperationReceiptSchema } from '../contracts/index.ts';
import { HubError } from '../domain/errors.ts';
import { digest } from '../persistence/codec.ts';

const rowSchema = z.object({ value: z.string() });
export class ConnectorLedger {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS connector_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  }
  key(ctx: CallContext, id: string): string { return JSON.stringify([ctx.workspaceId, ctx.installationId, id]); }
  get<T>(key: string, schema: ZodType<T>): T | undefined {
    const raw = this.database.prepare('SELECT value FROM connector_state WHERE key=?').get(key);
    return raw === undefined ? undefined : schema.parse(JSON.parse(rowSchema.parse(raw).value));
  }
  put(key: string, value: unknown): void {
    this.database.prepare('INSERT INTO connector_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  remove(key: string): void { this.database.prepare('DELETE FROM connector_state WHERE key=?').run(key); }
  async execute<T>(ctx: ActionContext, spec: {
    readonly kind: string; readonly schemaId: string; readonly schema: ZodType<T>;
    readonly input: unknown; readonly effect: string;
  }, effect: () => Promise<T>): Promise<OperationReceipt<T>> {
    const key = this.key(ctx, `operation:${ctx.operationId}`);
    const stamp = digest({ kind: spec.kind, input: spec.input, inputDigest: ctx.inputDigest });
    const base = { operationId: ctx.operationId, operationKind: spec.kind,
      resultSchemaId: spec.schemaId, updatedAt: new Date().toISOString(), partialEffects: [] };
    const pending: OperationReceipt<T> = { ...base, status: 'unknown', error: {
      code: 'delivery_uncertain', category: 'unavailable',
      message: 'The operation may have reached the provider. Reconcile or inspect the native session; do not resend.',
      retry: 'reconcile_first',
    } };
    const claim = this.database.prepare('INSERT INTO connector_state VALUES(?,?) ON CONFLICT(key) DO NOTHING')
      .run(key, JSON.stringify({ stamp, receipt: pending }));
    if (claim.changes === 0) {
      const entry = this.get(key, z.object({ stamp: z.string(), receipt: SerializedOperationReceiptSchema }));
      if (!entry || entry.stamp !== stamp) throw new HubError({ code: 'operation_input_conflict', category: 'conflict',
        message: 'The operation ID is already bound to different input.', retry: 'never' });
      return deserialize(entry.receipt, spec.schema);
    }
    try {
      const result = spec.schema.parse(await effect());
      const receipt: OperationReceipt<T> = { ...base, updatedAt: new Date().toISOString(),
        status: 'confirmed', result, evidence: { effect: spec.effect, source: 'state_inspection', observedAt: new Date().toISOString() } };
      this.put(key, { stamp, receipt });
      return receipt;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const uncertain: OperationReceipt<T> = { ...pending,
        error: error instanceof HubError ? error.data : pending.error };
      this.put(key, { stamp, receipt: uncertain });
      return uncertain;
    }
  }
  lookup(ctx: CallContext, operationId: string): OperationLookup {
    const entry = this.get(this.key(ctx, `operation:${operationId}`), z.object({ receipt: SerializedOperationReceiptSchema }));
    return entry ? { kind: 'found', receipt: deserialize(entry.receipt, JsonValueSchema) } : { kind: 'not_found', absence: 'not_authoritative' };
  }
  confirm(ctx: CallContext, operationId: string, result: unknown, effect: string): void {
    const key = this.key(ctx, `operation:${operationId}`);
    const entry = this.get(key, z.object({ stamp: z.string(), receipt: SerializedOperationReceiptSchema }));
    if (!entry) throw new TypeError('Cannot confirm an unrecorded connector operation.');
    const updatedAt = new Date().toISOString();
    this.put(key, { stamp: entry.stamp, receipt: { ...entry.receipt, status: 'confirmed',
      error: undefined, reconciliationHint: undefined, result, updatedAt,
      evidence: { effect, source: 'state_inspection', observedAt: updatedAt } } });
  }
  close(): void { this.database.close(); }
}

function deserialize<T>(receipt: SerializedOperationReceipt, schema: ZodType<T>): OperationReceipt<T> {
  const base = { operationId: receipt.operationId, operationKind: receipt.operationKind,
    resultSchemaId: receipt.resultSchemaId, updatedAt: receipt.updatedAt, partialEffects: receipt.partialEffects,
    ...(receipt.providerReceiptRef === undefined ? {} : { providerReceiptRef: receipt.providerReceiptRef }) };
  switch (receipt.status) {
    case 'confirmed': return { ...base, status: 'confirmed', result: schema.parse(receipt.result), evidence: receipt.evidence };
    case 'accepted': case 'running': return { ...base, status: receipt.status, ...(receipt.progress === undefined ? {} : { progress: receipt.progress }) };
    case 'failed': case 'rejected': return { ...base, status: receipt.status, error: receipt.error };
    case 'unknown': return { ...base, status: 'unknown', error: receipt.error,
      ...(receipt.reconciliationHint === undefined ? {} : { reconciliationHint: receipt.reconciliationHint }) };
  }
}
