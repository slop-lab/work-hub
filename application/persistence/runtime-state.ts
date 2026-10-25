import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { Clock } from "./codec.ts";
import { parseJson } from "./codec.ts";
import { EnvironmentAttachmentSchema } from "../contracts/index.ts";
import { InboundEvents } from "./inbound-events.ts";

const runtimeDescriptorSchema = z.strictObject({
  controlGrant: z.strictObject({
    mode: z.union([z.literal("observe"), z.literal("control")]),
  }).passthrough(),
}).passthrough();
const observationCursorSchema = z.strictObject({
  output: z.string().optional(),
  events: z.string().optional(),
}).default({});

export class RuntimeState {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private readonly inboundEvents: InboundEvents;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
    this.inboundEvents = new InboundEvents(database, clock);
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
  }): boolean {
    const prior = z.strictObject({ lifecycleGrantJson: z.string().nullable() }).parse(
      this.database.prepare(`SELECT lifecycle_grant_json AS lifecycleGrantJson
        FROM environment_bindings WHERE workspace_id = ? AND id = ?`)
        .get(input.workspaceId, input.bindingId),
    ).lifecycleGrantJson;
    const supplied = input.lifecycleGrant === undefined ? undefined : JSON.stringify(input.lifecycleGrant);
    const compatible = prior === null || supplied === undefined || prior === supplied;
    const lifecycleGrantJson = prior ?? supplied ?? null;
    this.database.prepare(`UPDATE environment_bindings SET attachment_json = ?, identity_json = ?,
      use_grant_json = ?, lifecycle_grant_json = ?, state = 'attached', updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(JSON.stringify(input.attachment),
      JSON.stringify(input.identity), JSON.stringify(input.useGrant),
      lifecycleGrantJson,
      this.clock.now().toISOString(), input.workspaceId, input.bindingId);
    return compatible;
  }

  saveOutput(input: {
    readonly workspaceId: string; readonly sessionId: string; readonly attemptId?: string;
    readonly bindingGeneration: number; readonly sourceItemId?: string; readonly item: object;
  }): void {
    this.insertOutput(input);
  }

  saveOutputPage(input: {
    readonly workspaceId: string; readonly sessionId: string;
    readonly bindingGeneration: number; readonly items: readonly {
      readonly attemptId?: string; readonly sourceItemId?: string; readonly item: object;
    }[]; readonly nextCursor?: string;
  }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of input.items) this.insertOutput({
        workspaceId: input.workspaceId, sessionId: input.sessionId,
        ...(item.attemptId === undefined ? {} : { attemptId: item.attemptId }),
        bindingGeneration: input.bindingGeneration,
        ...(item.sourceItemId === undefined ? {} : { sourceItemId: item.sourceItemId }),
        item: item.item,
      });
      if (input.nextCursor !== undefined) {
        this.updateObservationCursor(input.workspaceId, input.sessionId, { output: input.nextCursor });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertOutput(input: {
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

  runtimeBindings(input: { readonly limit: number; readonly after?: string }): readonly {
    readonly workspaceId: string; readonly sessionId: string; readonly generation: number;
    readonly descriptor: Readonly<Record<string, unknown>>;
  }[] {
    const rows = this.database.prepare(`SELECT b.workspace_id AS workspaceId,
      b.session_id AS sessionId, b.generation, b.descriptor_json AS descriptorJson
      FROM runtime_bindings b JOIN sessions s
        ON s.workspace_id = b.workspace_id AND s.id = b.session_id
      WHERE s.lifecycle <> 'closed' ORDER BY b.session_id`).all();
    const bindings = rows.map((row) => {
      const value = z.strictObject({ workspaceId: z.string(), sessionId: z.string(),
        generation: z.number(), descriptorJson: z.string() }).parse(row);
      return { workspaceId: value.workspaceId, sessionId: value.sessionId,
        generation: value.generation,
        descriptor: z.record(z.string(), z.unknown()).parse(parseJson(value.descriptorJson)) };
    });
    const after = input.after;
    const split = after === undefined
      ? 0
      : Math.max(0, bindings.findIndex((binding) => binding.sessionId > after));
    return [...bindings.slice(split), ...bindings.slice(0, split)].slice(0, input.limit);
  }

  observationCursors(workspaceId: string, sessionId: string): {
    readonly output?: string; readonly events?: string;
  } {
    const row = z.strictObject({ observationJson: z.string().nullable() }).parse(
      this.database.prepare(`SELECT last_observation_json AS observationJson FROM runtime_bindings
        WHERE workspace_id = ? AND session_id = ?`).get(workspaceId, sessionId),
    );
    if (row.observationJson === null) return {};
    const parsed = observationCursorSchema.parse(parseJson(row.observationJson));
    return {
      ...(parsed.output === undefined ? {} : { output: parsed.output }),
      ...(parsed.events === undefined ? {} : { events: parsed.events }),
    };
  }

  saveEventCursor(workspaceId: string, sessionId: string, cursor: string): void {
    this.updateObservationCursor(workspaceId, sessionId, { events: cursor });
  }

  environmentBindings(input: { readonly limit: number; readonly after?: string }): readonly {
    readonly workspaceId: string; readonly bindingId: string; readonly sessionId: string;
    readonly attemptId?: string; readonly attachment: ReturnType<typeof EnvironmentAttachmentSchema.parse>;
  }[] {
    const rows = this.database.prepare(`SELECT b.workspace_id AS workspaceId, b.id AS bindingId,
      b.session_id AS sessionId, b.attempt_id AS attemptId, b.attachment_json AS attachmentJson
      FROM environment_bindings b JOIN sessions s
        ON s.workspace_id = b.workspace_id AND s.id = b.session_id
      WHERE b.state = 'attached' AND b.attachment_json IS NOT NULL AND s.lifecycle <> 'closed'
      ORDER BY b.id`).all().map((row) => z.strictObject({ workspaceId: z.string(),
        bindingId: z.string(), sessionId: z.string(), attemptId: z.string().nullable(),
        attachmentJson: z.string() }).parse(row));
    const bindings = rows.map((row) => ({ workspaceId: row.workspaceId, bindingId: row.bindingId,
      sessionId: row.sessionId, ...(row.attemptId === null ? {} : { attemptId: row.attemptId }),
      attachment: EnvironmentAttachmentSchema.parse(parseJson(row.attachmentJson)) }));
    const after = input.after;
    const split = after === undefined
      ? 0
      : Math.max(0, bindings.findIndex((binding) => binding.bindingId > after));
    return [...bindings.slice(split), ...bindings.slice(0, split)].slice(0, input.limit);
  }

  private updateObservationCursor(
    workspaceId: string,
    sessionId: string,
    update: { readonly output?: string; readonly events?: string },
  ): void {
    const current = this.observationCursors(workspaceId, sessionId);
    this.database.prepare(`UPDATE runtime_bindings SET last_observation_json = ?, updated_at = ?
      WHERE workspace_id = ? AND session_id = ?`).run(JSON.stringify({ ...current, ...update }),
      this.clock.now().toISOString(), workspaceId, sessionId);
  }

  claimInboundEvent(input: {
    readonly workspaceId: string; readonly installationId: string;
    readonly sourceEventId: string; readonly bindingGeneration: number; readonly event: object;
  }, apply: () => void = () => {}): boolean {
    return this.inboundEvents.claim(input, apply);
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
