import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "./codec.ts";

export class OperationSettlement {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  updateOperation(
    id: string,
    status: "confirmed" | "rejected" | "failed" | "unknown",
    receipt: object,
  ): void {
    this.database.prepare(`UPDATE external_operations SET status = ?, receipt_json = ?, updated_at = ?
      WHERE id = ?`).run(status, JSON.stringify(receipt), this.clock.now().toISOString(), id);
  }

  settleReconciliation(input: {
    readonly originalOperationId: string; readonly reconciliationOutboxId: string;
    readonly status: "confirmed" | "rejected" | "failed" | "unknown";
    readonly receipt: object; readonly apply: () => void;
  }): void {
    this.transaction(() => {
      const now = this.clock.now().toISOString();
      input.apply();
      this.database.prepare(`UPDATE external_operations SET status = ?, receipt_json = ?,
        updated_at = ? WHERE id = ?`).run(
          input.status, JSON.stringify(input.receipt), now, input.originalOperationId,
        );
      this.finishOutbox(input.reconciliationOutboxId, now);
      this.database.prepare(`UPDATE external_operations SET status = 'confirmed', receipt_json = ?,
        updated_at = ? WHERE id = (SELECT operation_id FROM outbox WHERE id = ?)`)
        .run(JSON.stringify(input.receipt), now, input.reconciliationOutboxId);
    });
  }

  markOutbox(id: string, state: "done" | "pending" | "unknown", receipt?: object): void {
    this.transaction(() => {
      const now = this.clock.now().toISOString();
      this.database.prepare(`UPDATE outbox SET state = ?, attempts = attempts + 1,
        next_due_at = ?, updated_at = ? WHERE id = ?`).run(state, now, now, id);
      if (receipt === undefined) return;
      const receiptStatus = Reflect.get(receipt, "status");
      const operationStatus = typeof receiptStatus === "string" &&
        ["accepted", "running", "confirmed", "rejected", "failed", "unknown"].includes(receiptStatus)
        ? receiptStatus : state === "done" ? "confirmed" : state;
      this.database.prepare(`UPDATE external_operations SET status = ?, receipt_json = ?, updated_at = ?
        WHERE id = (SELECT operation_id FROM outbox WHERE id = ?)`)
        .run(operationStatus, JSON.stringify(receipt), now, id);
    });
  }

  settleConfirmed(id: string, receipt: object, apply: () => void): void {
    this.transaction(() => {
      const now = this.clock.now().toISOString();
      apply();
      this.finishOutbox(id, now);
      this.database.prepare(`UPDATE external_operations SET status = 'confirmed', receipt_json = ?,
        updated_at = ? WHERE id = (SELECT operation_id FROM outbox WHERE id = ?)`)
        .run(JSON.stringify(receipt), now, id);
    });
  }

  settleTerminal(
    id: string,
    status: "rejected" | "failed",
    receipt: object,
    apply: () => void,
  ): void {
    this.transaction(() => {
      const now = this.clock.now().toISOString();
      apply();
      this.finishOutbox(id, now);
      this.database.prepare(`UPDATE external_operations SET status = ?, receipt_json = ?,
        updated_at = ? WHERE id = (SELECT operation_id FROM outbox WHERE id = ?)`)
        .run(status, JSON.stringify(receipt), now, id);
    });
  }

  markForLookup(id: string, receipt: object): void {
    this.transaction(() => {
      const now = this.clock.now().toISOString();
      this.database.prepare(`UPDATE outbox SET work_type = 'operation.lookup', state = 'unknown',
        attempts = attempts + 1, next_due_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
      this.database.prepare(`UPDATE external_operations SET status = 'unknown', receipt_json = ?,
        updated_at = ? WHERE id = (SELECT operation_id FROM outbox WHERE id = ?)`)
        .run(JSON.stringify(receipt), now, id);
    });
  }

  private finishOutbox(id: string, now: string): void {
    this.database.prepare(`UPDATE outbox SET state = 'done', attempts = attempts + 1,
      next_due_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
  }

  private transaction(apply: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try { apply(); this.database.exec("COMMIT"); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
