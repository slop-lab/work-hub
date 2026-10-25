import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { Clock } from "./codec.ts";
import { parseJson } from "./codec.ts";

const runtimeDescriptorSchema = z.strictObject({
  controlGrant: z.strictObject({
    mode: z.union([z.literal("observe"), z.literal("control")]),
  }).passthrough(),
}).passthrough();

export class RuntimeState {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  bindRuntime(input: {
    readonly workspaceId: string; readonly sessionId: string; readonly nativeIdentityKey: string;
    readonly capabilities: object; readonly descriptor: object; readonly generation: number;
  }): void {
    const now = this.clock.now().toISOString();
    const descriptor = runtimeDescriptorSchema.parse(input.descriptor);
    this.database.prepare(`UPDATE sessions SET lifecycle = 'open', native_identity_key = ?,
       capabilities_json = ?, control_mode = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND id = ?`).run(input.nativeIdentityKey,
       JSON.stringify(input.capabilities), descriptor.controlGrant.mode, now,
       input.workspaceId, input.sessionId);
    this.database.prepare(`INSERT INTO runtime_bindings
      (session_id, workspace_id, descriptor_json, generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      descriptor_json = excluded.descriptor_json, generation = excluded.generation,
      updated_at = excluded.updated_at`).run(input.sessionId, input.workspaceId,
      JSON.stringify(input.descriptor), input.generation, now, now);
  }

  saveEnvironmentAttachment(input: {
    readonly workspaceId: string; readonly bindingId: string; readonly attachment: object;
    readonly identity: object; readonly useGrant: object; readonly lifecycleGrant?: object;
  }): void {
    this.database.prepare(`UPDATE environment_bindings SET attachment_json = ?, identity_json = ?,
      use_grant_json = ?, lifecycle_grant_json = ?, state = 'attached', updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(JSON.stringify(input.attachment),
      JSON.stringify(input.identity), JSON.stringify(input.useGrant),
      input.lifecycleGrant === undefined ? null : JSON.stringify(input.lifecycleGrant),
      this.clock.now().toISOString(), input.workspaceId, input.bindingId);
  }

  saveOutput(input: {
    readonly workspaceId: string; readonly sessionId: string; readonly attemptId?: string;
    readonly bindingGeneration: number; readonly sourceItemId?: string; readonly item: object;
  }): void {
    const sequenceRow = z.strictObject({ next: z.number() }).parse(
      this.database.prepare(`SELECT COALESCE(MAX(local_sequence), 0) + 1 AS next
        FROM output_chunks WHERE session_id = ?`).get(input.sessionId),
    );
    this.database.prepare(`INSERT OR IGNORE INTO output_chunks
      (id, workspace_id, session_id, attempt_id, local_sequence, source_item_id,
       binding_generation, item_json, created_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.workspaceId,
      input.sessionId, input.attemptId ?? null, sequenceRow.next, input.sourceItemId ?? null,
      input.bindingGeneration, JSON.stringify(input.item), this.clock.now().toISOString());
  }

  updateControlGrant(workspaceId: string, sessionId: string, descriptor: object): void {
    const now = this.clock.now().toISOString();
    const parsed = runtimeDescriptorSchema.parse(descriptor);
    this.database.prepare(`UPDATE runtime_bindings SET descriptor_json = ?, updated_at = ?
      WHERE workspace_id = ? AND session_id = ?`).run(JSON.stringify(descriptor), now,
      workspaceId, sessionId);
    this.database.prepare(`UPDATE sessions SET control_mode = ?, revision = revision + 1,
       updated_at = ? WHERE workspace_id = ? AND id = ?`).run(parsed.controlGrant.mode,
       now, workspaceId, sessionId);
  }

  runtimeBinding(workspaceId: string, sessionId: string): Readonly<Record<string, unknown>> {
    return this.runtimeBindingRecord(workspaceId, sessionId).descriptor;
  }

  runtimeBindingRecord(workspaceId: string, sessionId: string): {
    readonly generation: number;
    readonly descriptor: Readonly<Record<string, unknown>>;
  } {
    const row = z.strictObject({ descriptorJson: z.string(), generation: z.number() }).parse(
      this.database.prepare(`SELECT descriptor_json AS descriptorJson, generation FROM runtime_bindings
        WHERE workspace_id = ? AND session_id = ?`).get(workspaceId, sessionId),
    );
    return {
      generation: row.generation,
      descriptor: z.record(z.string(), z.unknown()).parse(parseJson(row.descriptorJson)),
    };
  }

  runtimeBindings(workspaceId?: string): readonly {
    readonly workspaceId: string; readonly sessionId: string; readonly generation: number;
    readonly descriptor: Readonly<Record<string, unknown>>;
  }[] {
    const rows = workspaceId === undefined
      ? this.database.prepare(`SELECT workspace_id AS workspaceId, session_id AS sessionId,
          generation, descriptor_json AS descriptorJson FROM runtime_bindings`).all()
      : this.database.prepare(`SELECT workspace_id AS workspaceId, session_id AS sessionId,
          generation, descriptor_json AS descriptorJson FROM runtime_bindings
          WHERE workspace_id = ?`).all(workspaceId);
    return rows.map((row) => {
      const value = z.strictObject({ workspaceId: z.string(), sessionId: z.string(),
        generation: z.number(), descriptorJson: z.string() }).parse(row);
      return { workspaceId: value.workspaceId, sessionId: value.sessionId,
        generation: value.generation,
        descriptor: z.record(z.string(), z.unknown()).parse(parseJson(value.descriptorJson)) };
    });
  }

  lastOutputCursor(sessionId: string): string | undefined {
    const row = z.strictObject({ sourceItemId: z.string().nullable() }).optional().parse(
      this.database.prepare(`SELECT source_item_id AS sourceItemId FROM output_chunks
        WHERE session_id = ? AND source_item_id IS NOT NULL ORDER BY local_sequence DESC LIMIT 1`)
        .get(sessionId),
    );
    return row?.sourceItemId ?? undefined;
  }

  claimInboundEvent(input: {
    readonly workspaceId: string; readonly installationId: string;
    readonly sourceEventId: string; readonly bindingGeneration: number; readonly event: object;
  }): boolean {
    const event = z.strictObject({ streamScope: z.string(), sourceSequence: z.number().optional(),
      nativeSession: z.strictObject({ installationId: z.string(), providerScope: z.string(),
        kind: z.string(), id: z.string(), incarnation: z.string().optional() })
    }).passthrough().parse(input.event);
    if (event.sourceSequence !== undefined && this.database.prepare(`SELECT 1 FROM inbound_events
      WHERE workspace_id = ? AND installation_id = ? AND binding_generation = ?
        AND json_extract(event_json, '$.streamScope') = ?
        AND json_extract(event_json, '$.nativeSession.providerScope') = ?
        AND json_extract(event_json, '$.nativeSession.kind') = ?
        AND json_extract(event_json, '$.nativeSession.id') = ?
        AND CAST(json_extract(event_json, '$.sourceSequence') AS INTEGER) >= ? LIMIT 1`).get(
      input.workspaceId, input.installationId, input.bindingGeneration, event.streamScope,
      event.nativeSession.providerScope, event.nativeSession.kind, event.nativeSession.id,
      event.sourceSequence) !== undefined) return false;
    const result = this.database.prepare(`INSERT OR IGNORE INTO inbound_events
      (id, workspace_id, installation_id, source_event_id, binding_generation, event_json, received_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)`).run(input.workspaceId,
      input.installationId, input.sourceEventId, input.bindingGeneration,
      JSON.stringify(input.event), this.clock.now().toISOString());
    return result.changes === 1;
  }

  markSessionUnreachable(workspaceId: string, sessionId: string): void {
    this.database.prepare(`UPDATE attempts SET observation = 'unreachable', updated_at = ?
      WHERE workspace_id = ? AND session_id = ? AND unresolved = 1`).run(
      this.clock.now().toISOString(), workspaceId, sessionId);
  }

  attemptBelongs(workspaceId: string, sessionId: string, attemptId: string): boolean {
    return this.database.prepare(`SELECT 1 FROM attempts WHERE workspace_id = ? AND session_id = ?
      AND id = ?`).get(workspaceId, sessionId, attemptId) !== undefined;
  }
}
