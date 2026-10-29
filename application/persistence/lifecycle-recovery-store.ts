import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { InterruptionKind, RecoveryKind } from "../domain/lifecycle-model.ts";
import { conflict } from "../domain/errors.ts";
import type { Clock } from "./codec.ts";

export class LifecycleRecoveryStore {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  reconcile(input: { readonly workspaceId: string; readonly attemptId: string;
    readonly interruption: InterruptionKind; readonly recovery: RecoveryKind }): void {
    this.database.prepare(`UPDATE attempts SET interruption_kind=?,recovery_kind=?,updated_at=?
      WHERE workspace_id=? AND id=?`).run(input.interruption, input.recovery,
      this.clock.now().toISOString(), input.workspaceId, input.attemptId);
  }

  control(input: { readonly workspaceId: string; readonly attemptId: string;
    readonly recovery: Extract<RecoveryKind, "resume" | "retry" | "escalated">;
    readonly reason: string; readonly retryLimit: number }): void {
    const attempt = z.object({ retryOrdinal: z.number() }).parse(this.database.prepare(
      "SELECT retry_ordinal AS retryOrdinal FROM attempts WHERE workspace_id=? AND id=?",
    ).get(input.workspaceId, input.attemptId));
    const ordinal = input.recovery === "retry" ? attempt.retryOrdinal + 1 : attempt.retryOrdinal;
    if (ordinal > input.retryLimit) throw conflict("retry_budget_exhausted", "Retry budget is exhausted.");
    this.database.prepare(`UPDATE attempts SET recovery_kind=?,retry_ordinal=?,retry_limit=?,
      retry_reason=?,updated_at=? WHERE workspace_id=? AND id=?`).run(input.recovery, ordinal,
      input.retryLimit, input.reason, this.clock.now().toISOString(), input.workspaceId, input.attemptId);
  }

  recordRetry(input: { readonly workspaceId: string; readonly attemptId: string;
    readonly predecessorOrdinal: number; readonly limit: number; readonly reason: string }): void {
    const ordinal = input.predecessorOrdinal + 1;
    if (ordinal > input.limit) throw conflict("retry_budget_exhausted", "Retry budget is exhausted.");
    this.database.prepare(`UPDATE attempts SET recovery_kind='retry',retry_ordinal=?,retry_limit=?,
      retry_reason=?,updated_at=? WHERE workspace_id=? AND id=?`).run(ordinal, input.limit,
      input.reason, this.clock.now().toISOString(), input.workspaceId, input.attemptId);
  }

  recordResume(input: { readonly workspaceId: string; readonly attemptId: string;
    readonly retryOrdinal: number; readonly retryLimit: number; readonly reason: string }): void {
    this.database.prepare(`UPDATE attempts SET recovery_kind='resume',retry_ordinal=?,retry_limit=?,
      retry_reason=?,updated_at=? WHERE workspace_id=? AND id=?`).run(input.retryOrdinal,
      input.retryLimit, input.reason, this.clock.now().toISOString(), input.workspaceId, input.attemptId);
  }
}
