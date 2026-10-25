import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { ResultView } from "../domain/model.ts";
import type { Clock } from "./codec.ts";
import { newId, parseJson } from "./codec.ts";

const objectSchema = z.record(z.string(), z.unknown());
const resultRowSchema = z.strictObject({
  id: z.string(), workspaceId: z.string(), taskId: z.string(), attemptId: z.string(),
  authorId: z.string(), summary: z.string(), limitationsJson: z.string(),
  referenceIdsJson: z.string(), evidenceJson: z.string(), createdAt: z.string(),
});

function toResult(row: unknown): ResultView {
  const value = resultRowSchema.parse(row);
  return {
    id: value.id, workspaceId: value.workspaceId, taskId: value.taskId,
    attemptId: value.attemptId, authorId: value.authorId, summary: value.summary,
    limitations: z.array(z.string()).parse(parseJson(value.limitationsJson)),
    referenceIds: z.array(z.string()).parse(parseJson(value.referenceIdsJson)),
    evidence: z.array(objectSchema).parse(parseJson(value.evidenceJson)),
    createdAt: value.createdAt,
  };
}

const resultSelect = `SELECT id, workspace_id AS workspaceId, task_id AS taskId,
  attempt_id AS attemptId, author_id AS authorId, summary,
  limitations_json AS limitationsJson, reference_ids_json AS referenceIdsJson,
  evidence_json AS evidenceJson, created_at AS createdAt FROM results`;

export class ResultRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  create(input: {
    readonly workspaceId: string; readonly taskId: string; readonly attemptId: string;
    readonly authorId: string; readonly summary: string; readonly limitations: readonly string[];
    readonly referenceIds: readonly string[]; readonly evidence: readonly object[];
  }): ResultView {
    const id = newId("result");
    this.database.prepare(`INSERT INTO results
      (id, workspace_id, task_id, attempt_id, author_id, summary, limitations_json,
       reference_ids_json, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.workspaceId, input.taskId, input.attemptId, input.authorId, input.summary,
        JSON.stringify(input.limitations), JSON.stringify(input.referenceIds),
        JSON.stringify(input.evidence), this.clock.now().toISOString());
    return this.get(input.workspaceId, id);
  }

  get(workspaceId: string, id: string): ResultView {
    return toResult(this.database.prepare(`${resultSelect} WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, id));
  }

  list(workspaceId: string): readonly ResultView[] {
    return this.database.prepare(`${resultSelect} WHERE workspace_id = ? ORDER BY created_at DESC`)
      .all(workspaceId).map(toResult);
  }
}
