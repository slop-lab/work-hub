import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { Clock } from "./codec.ts";
import { parseJson } from "./codec.ts";

export type OutboxItem = {
  readonly id: string;
  readonly leaseToken: string;
  readonly workspaceId: string;
  readonly operationId?: string;
  readonly commandId: string;
  readonly connectorKind: "execution" | "runtime";
  readonly installationId: string;
  readonly inputDigest: string;
  readonly operationKind: string;
  readonly targetId?: string;
  readonly targetGeneration?: number;
  readonly workType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
};

const rowSchema = z.strictObject({
  id: z.string(), workspaceId: z.string(), operationId: z.string().nullable(),
  commandId: z.string(), connectorKind: z.union([z.literal("execution"), z.literal("runtime")]),
  installationId: z.string(), inputDigest: z.string(), operationKind: z.string(),
  targetId: z.string().nullable(), targetGeneration: z.number().nullable(),
  workType: z.string(), payloadJson: z.string(), attempts: z.number(),
});

export class OutboxClaims {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  claimDue(limit: number, leaseMilliseconds: number): readonly OutboxItem[] {
    const now = this.clock.now();
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + leaseMilliseconds).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const ids = this.database.prepare(`SELECT id FROM outbox
        WHERE state IN ('pending','unknown') AND next_due_at <= ?
          AND (lease_until IS NULL OR lease_until <= ?)
        ORDER BY next_due_at, id LIMIT ?`).all(now.toISOString(), now.toISOString(), limit);
      const update = this.database.prepare(`UPDATE outbox SET lease_token = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)`);
      for (const row of ids) {
        const id = z.strictObject({ id: z.string() }).parse(row).id;
        update.run(leaseToken, leaseUntil, now.toISOString(), id, now.toISOString());
      }
      const rows = this.rowsForLease(leaseToken);
      this.database.exec("COMMIT");
      return rows.map((row) => this.item(rowSchema.parse(row), leaseToken));
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private rowsForLease(leaseToken: string): readonly unknown[] {
    return this.database.prepare(`SELECT o.id, o.workspace_id AS workspaceId,
      o.operation_id AS operationId, x.command_id AS commandId,
      x.connector_kind AS connectorKind, x.installation_id AS installationId,
      x.input_digest AS inputDigest, x.operation_kind AS operationKind, o.work_type AS workType,
      x.target_id AS targetId, x.target_generation AS targetGeneration,
      o.payload_json AS payloadJson, o.attempts
      FROM outbox o JOIN external_operations x ON x.id = o.operation_id
      WHERE o.lease_token = ? ORDER BY o.next_due_at, o.id`).all(leaseToken);
  }

  private item(value: z.infer<typeof rowSchema>, leaseToken: string): OutboxItem {
    return {
      id: value.id, leaseToken, workspaceId: value.workspaceId,
      ...(value.operationId === null ? {} : { operationId: value.operationId }),
      commandId: value.commandId, connectorKind: value.connectorKind,
      installationId: value.installationId, inputDigest: value.inputDigest,
      operationKind: value.operationKind,
      ...(value.targetId === null ? {} : { targetId: value.targetId }),
      ...(value.targetGeneration === null ? {} : { targetGeneration: value.targetGeneration }),
      workType: value.workType,
      payload: z.record(z.string(), z.unknown()).parse(parseJson(value.payloadJson)),
      attempts: value.attempts,
    };
  }
}
