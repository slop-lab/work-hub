import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { BindingObservationSchema } from "../contracts/index.ts";
import type { Clock } from "./codec.ts";
import { parseJson } from "./codec.ts";

const environmentSafetySchema = z.union([
  z.literal("fresh"), z.literal("stale"), z.literal("unsafe"), z.literal("unreachable"),
]);

export type EnvironmentSafety = z.infer<typeof environmentSafetySchema>;

export class EnvironmentObservationState {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  save(input: {
    readonly workspaceId: string; readonly bindingId: string;
    readonly observation: object; readonly safety: EnvironmentSafety;
  }): void {
    const parsed = BindingObservationSchema.safeParse(input.observation);
    const now = this.clock.now().toISOString();
    const record = { safety: input.safety, observedAt: now,
      ...(parsed.success ? { value: parsed.data } : {}),
      ...(parsed.success ? {} : { error: input.observation }) };
    this.database.prepare(`UPDATE environment_bindings SET observation_json = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(
      JSON.stringify(record), now, input.workspaceId, input.bindingId,
    );
    if (input.safety === "fresh") return;
    const attemptObservation = input.safety === "unreachable" ? "unreachable" : "stale";
    this.database.prepare(`UPDATE attempts SET observation = ?, updated_at = ?
      WHERE workspace_id = ? AND unresolved = 1 AND session_id = (
        SELECT session_id FROM environment_bindings WHERE workspace_id = ? AND id = ?
      )`).run(attemptObservation, now, input.workspaceId, input.workspaceId, input.bindingId);
  }

  safety(workspaceId: string, sessionId: string): EnvironmentSafety | undefined {
    const row = z.strictObject({ observationJson: z.string().nullable() }).optional().parse(
      this.database.prepare(`SELECT observation_json AS observationJson
        FROM environment_bindings WHERE workspace_id = ? AND session_id = ? AND state = 'attached'
        ORDER BY updated_at DESC, id LIMIT 1`).get(workspaceId, sessionId),
    );
    if (row?.observationJson === null || row === undefined) return undefined;
    return z.strictObject({ safety: environmentSafetySchema }).passthrough()
      .parse(parseJson(row.observationJson)).safety;
  }
}
