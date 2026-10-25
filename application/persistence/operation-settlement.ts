import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { Clock } from "./codec.ts";
import { currentOutboxLease, LeaseLostError } from "./outbox-lease.ts";

const MAX_AUTOMATIC_LOOKUPS = 12;
const MAX_LOOKUP_DELAY_MS = 300_000;
const DISABLED_DUE_AT = "9999-12-31T23:59:59.999Z";

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

  assertOwned(id: string): void {
    const lease = currentOutboxLease(id);
    const owned = this.database.prepare(`SELECT 1 FROM outbox
      WHERE id = ? AND lease_token = ? AND lease_until > ?`).get(
      id, lease.leaseToken, this.clock.now().toISOString(),
    );
    if (owned === undefined) throw new LeaseLostError(id);
  }

  recordExpectedAttachment(id: string, input: {
    readonly expectedIdentity: object;
    readonly selectedUseGrantId: string;
  }): void {
    this.transaction(() => {
      this.assertOwned(id);
      const row = z.strictObject({ operationId: z.string(), payloadJson: z.string(), inputJson: z.string() })
        .parse(this.database.prepare(`SELECT o.operation_id AS operationId,
          o.payload_json AS payloadJson, x.input_json AS inputJson
          FROM outbox o JOIN external_operations x ON x.id = o.operation_id WHERE o.id = ?`).get(id));
      const association = {
        expectedIdentity: input.expectedIdentity,
        selectedUseGrantId: input.selectedUseGrantId,
      };
      const payload = { ...z.record(z.string(), z.unknown()).parse(JSON.parse(row.payloadJson)), ...association };
      const operationInput = {
        ...z.record(z.string(), z.unknown()).parse(JSON.parse(row.inputJson)), ...association,
      };
      const now = this.clock.now().toISOString();
      this.database.prepare(`UPDATE outbox SET payload_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(payload), now, id);
      this.database.prepare(`UPDATE external_operations SET input_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(operationInput), now, row.operationId);
    });
  }

  settleReconciliation(input: {
    readonly originalOperationId: string; readonly reconciliationOutboxId: string;
    readonly status: "confirmed" | "rejected" | "failed" | "unknown";
    readonly receipt: object; readonly apply: () => void;
  }): void {
    this.transaction(() => {
      this.assertOwned(input.reconciliationOutboxId);
      const now = this.clock.now().toISOString();
      const original = z.strictObject({ status: z.string() }).parse(
        this.database.prepare("SELECT status FROM external_operations WHERE id = ?")
          .get(input.originalOperationId),
      );
      if (original.status !== "unknown") {
        this.finishOutbox(input.reconciliationOutboxId, now);
        this.database.prepare(`UPDATE external_operations SET status = 'confirmed', receipt_json = ?,
          updated_at = ? WHERE id = (SELECT operation_id FROM outbox WHERE id = ?)`)
          .run(JSON.stringify(input.receipt), now, input.reconciliationOutboxId);
        return;
      }
      this.database.prepare(`UPDATE outbox SET state = 'done', lease_token = NULL,
        lease_until = NULL, next_due_at = ?, updated_at = ? WHERE operation_id = ?`)
        .run(now, now, input.originalOperationId);
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
      this.assertOwned(id);
      const now = this.clock.now().toISOString();
      const nextDueAt = state === "done" ? now : this.nextLookupDueAt(id, false);
      this.database.prepare(`UPDATE outbox SET state = ?, attempts = attempts + 1,
        lease_token = NULL, lease_until = NULL, next_due_at = ?, updated_at = ? WHERE id = ?`)
        .run(state, nextDueAt, now, id);
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
      this.assertOwned(id);
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
      this.assertOwned(id);
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
      this.assertOwned(id);
      const now = this.clock.now().toISOString();
      const nextDueAt = this.nextLookupDueAt(id, true);
      this.database.prepare(`UPDATE outbox SET work_type = 'operation.lookup', state = 'unknown',
        attempts = attempts + 1, lease_token = NULL, lease_until = NULL,
        next_due_at = ?, updated_at = ? WHERE id = ?`).run(nextDueAt, now, id);
      this.database.prepare(`UPDATE external_operations SET status = 'unknown', receipt_json = ?,
        updated_at = ? WHERE id = (SELECT operation_id FROM outbox WHERE id = ?)`)
        .run(JSON.stringify(receipt), now, id);
    });
  }

  private finishOutbox(id: string, now: string): void {
    this.database.prepare(`UPDATE outbox SET state = 'done', attempts = attempts + 1,
      lease_token = NULL, lease_until = NULL, next_due_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
  }

  private nextLookupDueAt(id: string, immediateFirst: boolean): string {
    const attempts = z.strictObject({ attempts: z.number().int().nonnegative() }).parse(
      this.database.prepare("SELECT attempts FROM outbox WHERE id = ?").get(id),
    ).attempts;
    const nextAttempt = attempts + 1;
    if (nextAttempt >= MAX_AUTOMATIC_LOOKUPS) return DISABLED_DUE_AT;
    if (immediateFirst && nextAttempt === 1) return this.clock.now().toISOString();
    const retryOrdinal = immediateFirst ? nextAttempt - 1 : nextAttempt;
    const delay = Math.min(2 ** (retryOrdinal - 1) * 1_000, MAX_LOOKUP_DELAY_MS);
    return new Date(this.clock.now().getTime() + delay).toISOString();
  }

  private transaction(apply: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try { apply(); this.database.exec("COMMIT"); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
