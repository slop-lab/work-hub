import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { conflict } from "../domain/errors.ts";
import type { Clock } from "./codec.ts";

export class AttemptDeliveryRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  get(workspaceId: string, attemptId: string): Readonly<Record<string, unknown>> {
    return z.record(z.string(), z.unknown()).parse(this.database.prepare(`SELECT attempt_id AS attemptId,
      delivery_digest AS deliveryDigest,status,input_receipt_json AS inputReceiptJson,
      last_error_json AS lastErrorJson,updated_at AS updatedAt FROM attempt_deliveries
      WHERE workspace_id=? AND attempt_id=?`).get(workspaceId, attemptId));
  }

  optional(workspaceId: string, attemptId: string): Readonly<Record<string, unknown>> | undefined {
    const row = this.database.prepare(`SELECT attempt_id AS attemptId,delivery_digest AS deliveryDigest,
      status,input_receipt_json AS inputReceiptJson,last_error_json AS lastErrorJson,
      updated_at AS updatedAt FROM attempt_deliveries WHERE workspace_id=? AND attempt_id=?`)
      .get(workspaceId, attemptId);
    return row === undefined ? undefined : z.record(z.string(), z.unknown()).parse(row);
  }

  acknowledge(workspaceId: string, attemptId: string, deliveryDigest: string): void {
    const delivery = this.get(workspaceId, attemptId);
    if (delivery["deliveryDigest"] !== deliveryDigest) {
      throw conflict("delivery_digest_mismatch", "Acknowledgment does not match the assigned delivery.");
    }
    const changed = this.database.prepare(`UPDATE attempt_deliveries SET status='acknowledged',updated_at=?
      WHERE workspace_id=? AND attempt_id=? AND status IN ('pending','delivered','unknown')`)
      .run(this.clock.now().toISOString(), workspaceId, attemptId).changes;
    if (changed !== 1 && delivery["status"] !== "acknowledged") {
      throw conflict("delivery_not_acknowledgeable", "Delivery is not awaiting acknowledgment.");
    }
  }

  record(workspaceId: string, attemptId: string, input: {
    readonly status: "delivered" | "failed" | "unknown";
    readonly receipt?: object;
    readonly error?: object;
  }): void {
    this.database.prepare(`UPDATE attempt_deliveries SET status=?,input_receipt_json=?,
      last_error_json=?,updated_at=? WHERE workspace_id=? AND attempt_id=?
      AND status<>'acknowledged'`).run(input.status,
      input.receipt === undefined ? null : JSON.stringify(input.receipt),
      input.error === undefined ? null : JSON.stringify(input.error),
      this.clock.now().toISOString(), workspaceId, attemptId);
  }
}
