import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { HubCommandReceipt } from "../domain/model.ts";
import type { Clock } from "./codec.ts";
import { newId, parseJson } from "./codec.ts";
import { OutboxClaims, type OutboxItem } from "./outbox-claims.ts";
import { OperationSettlement } from "./operation-settlement.ts";

export type { OutboxItem } from "./outbox-claims.ts";

const receiptSchema = z.strictObject({
  commandId: z.string(), actorId: z.string(),
  status: z.union([
    z.literal("accepted"), z.literal("running"), z.literal("confirmed"),
    z.literal("rejected"), z.literal("failed"), z.literal("unknown"),
  ]),
  confirmedEffect: z.string().optional(),
  objectRefs: z.array(z.strictObject({
    kind: z.string(), id: z.string(), revision: z.number().optional(),
  })),
  operationIds: z.array(z.string()),
  error: z.strictObject({
    code: z.string(),
    category: z.union([
      z.literal("validation"), z.literal("authorization"), z.literal("authentication"),
      z.literal("conflict"), z.literal("identity_mismatch"), z.literal("unavailable"),
      z.literal("unsupported"), z.literal("requirements_not_met"), z.literal("timeout"),
      z.literal("provider_failure"),
    ]),
    message: z.string(),
    retry: z.union([
      z.literal("read_only_retry"), z.literal("same_operation_if_deduplicated"),
      z.literal("reconcile_first"), z.literal("manual_action"), z.literal("never"),
    ]),
    details: z.record(z.string(), z.union([
      z.string(), z.number(), z.boolean(), z.null(),
    ])).optional(),
  }).optional(),
});

export type OperationDescriptor = {
  readonly id: string; readonly workspaceId: string; readonly commandId: string;
  readonly connectorKind: "execution" | "runtime"; readonly installationId: string;
  readonly operationKind: string; readonly inputDigest: string;
  readonly status: "accepted" | "running" | "confirmed" | "rejected" | "failed" | "unknown";
  readonly targetId?: string; readonly targetGeneration?: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

export class OperationRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private readonly settlement: OperationSettlement;
  private readonly claims: OutboxClaims;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
    this.settlement = new OperationSettlement(database, clock);
    this.claims = new OutboxClaims(database, clock);
  }

  findReceipt(workspaceId: string, actorId: string, commandId: string): {
    readonly digest: string; readonly receipt: HubCommandReceipt;
  } | undefined {
    const row = this.database.prepare(`SELECT payload_digest AS digest, receipt_json AS receiptJson
      FROM command_receipts WHERE workspace_id = ? AND actor_id = ? AND command_id = ?`)
      .get(workspaceId, actorId, commandId);
    const parsed = z.strictObject({ digest: z.string(), receiptJson: z.string() }).optional().parse(row);
    return parsed === undefined ? undefined : {
      digest: parsed.digest,
      receipt: receiptSchema.parse(parseJson(parsed.receiptJson)),
    };
  }

  saveReceipt(input: {
    readonly workspaceId: string; readonly actorId: string; readonly commandId: string;
    readonly commandType: string; readonly payloadDigest: string; readonly command: object;
    readonly receipt: HubCommandReceipt;
  }): void {
    const now = this.clock.now().toISOString();
    this.database.prepare(`INSERT INTO command_receipts
      (workspace_id, actor_id, command_id, command_type, payload_digest, command_json,
       status, receipt_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.workspaceId, input.actorId, input.commandId, input.commandType,
        input.payloadDigest, JSON.stringify(input.command), input.receipt.status,
        JSON.stringify(input.receipt), now, now);
  }

  updateReceipt(workspaceId: string, actorId: string, receipt: HubCommandReceipt): void {
    this.database.prepare(`UPDATE command_receipts SET status = ?, receipt_json = ?, updated_at = ?
      WHERE workspace_id = ? AND actor_id = ? AND command_id = ?`)
      .run(receipt.status, JSON.stringify(receipt), this.clock.now().toISOString(),
        workspaceId, actorId, receipt.commandId);
  }

  addOutbox(input: {
    readonly workspaceId: string; readonly commandId: string; readonly workType: string;
    readonly connectorKind: "execution" | "runtime"; readonly installationId: string;
    readonly stage: string; readonly targetId?: string; readonly targetGeneration?: number;
    readonly payload: object; readonly inputDigest: string;
  }): string {
    const operationId = newId("operation");
    const outboxId = newId("outbox");
    const now = this.clock.now().toISOString();
    this.database.prepare(`INSERT INTO external_operations
      (id, workspace_id, command_id, connector_kind, installation_id, operation_kind,
       stage, target_id, target_generation, input_digest, input_json, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`)
      .run(operationId, input.workspaceId, input.commandId, input.connectorKind,
        input.installationId, input.workType, input.stage, input.targetId ?? null,
        input.targetGeneration ?? null, input.inputDigest, JSON.stringify(input.payload), now);
    this.database.prepare(`INSERT INTO outbox
      (id, workspace_id, operation_id, work_type, payload_json, state, next_due_at,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(outboxId, input.workspaceId, operationId, input.workType,
        JSON.stringify(input.payload), now, now, now);
    return operationId;
  }

  operation(workspaceId: string, id: string): OperationDescriptor | undefined {
    const row = this.database.prepare(`SELECT id, workspace_id AS workspaceId,
      command_id AS commandId, connector_kind AS connectorKind,
      installation_id AS installationId, operation_kind AS operationKind,
      input_digest AS inputDigest, status, target_id AS targetId,
      target_generation AS targetGeneration, input_json AS inputJson
      FROM external_operations WHERE workspace_id = ? AND id = ?`).get(workspaceId, id);
    const parsed = z.strictObject({
      id: z.string(), workspaceId: z.string(), commandId: z.string(),
      connectorKind: z.union([z.literal("execution"), z.literal("runtime")]),
      installationId: z.string(), operationKind: z.string(), inputDigest: z.string(),
      status: z.union([z.literal("accepted"), z.literal("running"), z.literal("confirmed"),
        z.literal("rejected"), z.literal("failed"), z.literal("unknown")]),
      targetId: z.string().nullable(), targetGeneration: z.number().nullable(), inputJson: z.string(),
    }).optional().parse(row);
    return parsed === undefined ? undefined : {
      id: parsed.id, workspaceId: parsed.workspaceId, commandId: parsed.commandId,
      connectorKind: parsed.connectorKind, installationId: parsed.installationId,
      operationKind: parsed.operationKind, inputDigest: parsed.inputDigest,
      status: parsed.status,
      ...(parsed.targetId === null ? {} : { targetId: parsed.targetId }),
      ...(parsed.targetGeneration === null ? {} : { targetGeneration: parsed.targetGeneration }),
      payload: z.record(z.string(), z.unknown()).parse(parseJson(parsed.inputJson)),
    };
  }

  unresolvedExecutionForTarget(workspaceId: string, targetId: string): OperationDescriptor | undefined {
    const row = this.database.prepare(`SELECT id FROM external_operations WHERE workspace_id = ?
      AND target_id = ? AND connector_kind = 'execution'
      AND status IN ('accepted','running','unknown') ORDER BY updated_at DESC LIMIT 1`)
      .get(workspaceId, targetId);
    const id = z.strictObject({ id: z.string() }).optional().parse(row)?.id;
    return id === undefined ? undefined : this.operation(workspaceId, id);
  }

  updateOperation(id: string, status: "confirmed" | "rejected" | "failed" | "unknown", receipt: object): void {
    this.settlement.updateOperation(id, status, receipt);
  }

  assertOwned(id: string): void {
    this.settlement.assertOwned(id);
  }

  recordExpectedAttachment(id: string, input: {
    readonly expectedIdentity: object;
    readonly selectedUseGrantId: string;
  }): void {
    this.settlement.recordExpectedAttachment(id, input);
  }

  settleReconciliation(input: {
    readonly originalOperationId: string; readonly reconciliationOutboxId: string;
    readonly status: "confirmed" | "rejected" | "failed" | "unknown";
    readonly receipt: object; readonly apply: () => void;
  }): void {
    this.settlement.settleReconciliation(input);
  }

  claimDue(limit: number, leaseMilliseconds = 30_000): readonly OutboxItem[] {
    return this.claims.claimDue(limit, leaseMilliseconds);
  }

  markOutbox(id: string, state: "done" | "pending" | "unknown", receipt?: object): void {
    this.settlement.markOutbox(id, state, receipt);
  }

  settleConfirmed(id: string, receipt: object, apply: () => void): void {
    this.settlement.settleConfirmed(id, receipt, apply);
  }

  settleTerminal(
    id: string,
    status: "rejected" | "failed",
    receipt: object,
    apply: () => void,
  ): void {
    this.settlement.settleTerminal(id, status, receipt, apply);
  }

  markForLookup(id: string, receipt: object): void {
    this.settlement.markForLookup(id, receipt);
  }

  audit(input: {
    readonly workspaceId: string; readonly actorId: string; readonly action: string;
    readonly targetKind?: string; readonly targetId?: string; readonly commandId?: string;
    readonly operationId?: string; readonly summary: object;
  }): void {
    this.database.prepare(`INSERT INTO audit_entries
      (workspace_id, actor_id, action, target_kind, target_id, command_id, operation_id,
       summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.workspaceId, input.actorId, input.action, input.targetKind ?? null,
        input.targetId ?? null, input.commandId ?? null, input.operationId ?? null,
        JSON.stringify(input.summary), this.clock.now().toISOString());
  }
}
