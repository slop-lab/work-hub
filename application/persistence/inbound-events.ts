import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { Clock } from "./codec.ts";

export type InboundEventClaim = {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly sourceEventId: string;
  readonly bindingGeneration: number;
  readonly event: object;
};

export class InboundEvents {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  claim(input: InboundEventClaim, apply: () => void): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const event = z.strictObject({ streamScope: z.string(), sourceSequence: z.number().optional(),
        nativeSession: z.strictObject({ installationId: z.string(), providerScope: z.string(),
          kind: z.string(), id: z.string(), incarnation: z.string().optional() })
      }).passthrough().parse(input.event);
      const superseded = event.sourceSequence !== undefined && this.database.prepare(`SELECT 1 FROM inbound_events
      WHERE workspace_id = ? AND installation_id = ? AND binding_generation = ?
        AND json_extract(event_json, '$.streamScope') = ?
        AND json_extract(event_json, '$.nativeSession.providerScope') = ?
        AND json_extract(event_json, '$.nativeSession.kind') = ?
        AND json_extract(event_json, '$.nativeSession.id') = ?
        AND COALESCE(json_extract(event_json, '$.nativeSession.incarnation'), '') = ?
        AND CAST(json_extract(event_json, '$.sourceSequence') AS INTEGER) >= ? LIMIT 1`).get(
        input.workspaceId, input.installationId, input.bindingGeneration, event.streamScope,
        event.nativeSession.providerScope, event.nativeSession.kind, event.nativeSession.id,
        event.nativeSession.incarnation ?? "", event.sourceSequence) !== undefined;
      const nativeSessionKey = JSON.stringify({ ...event.nativeSession, incarnation: event.nativeSession.incarnation ?? null });
      const claimed = !superseded && this.database.prepare(`INSERT OR IGNORE INTO inbound_events
      (id, workspace_id, installation_id, stream_scope, native_session_key,
       source_event_id, binding_generation, event_json, received_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.workspaceId,
        input.installationId, event.streamScope, nativeSessionKey,
        input.sourceEventId, input.bindingGeneration,
        JSON.stringify(input.event), this.clock.now().toISOString()).changes === 1;
      if (claimed) apply();
      this.database.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
