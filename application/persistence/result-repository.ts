import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { ResultView } from "../domain/model.ts";
import type { Clock } from "./codec.ts";
import { newId, parseJson } from "./codec.ts";
import { conflict } from "../domain/errors.ts";

const objectSchema = z.record(z.string(), z.unknown());
const resultRowSchema = z.strictObject({
  id: z.string(), workspaceId: z.string(), taskId: z.string(), attemptId: z.string(),
  authorId: z.string(), summary: z.string(), limitationsJson: z.string(),
  referenceIdsJson: z.string(), evidenceJson: z.string(), artifactsJson: z.string(), outcome: z.enum([
    "passed", "failed", "partial", "blocked", "unspecified",
  ]), submissionKey: z.string().nullable(), submissionDigest: z.string().nullable(),
  bindingJson: z.string().nullable(), createdAt: z.string(),
});

function toResult(row: unknown): ResultView {
  const value = resultRowSchema.parse(row);
  return {
    id: value.id, workspaceId: value.workspaceId, taskId: value.taskId,
    attemptId: value.attemptId, authorId: value.authorId, summary: value.summary,
    limitations: z.array(z.string()).parse(parseJson(value.limitationsJson)),
    referenceIds: z.array(z.string()).parse(parseJson(value.referenceIdsJson)),
    evidence: z.array(objectSchema).parse(parseJson(value.evidenceJson)),
    artifacts: z.array(objectSchema).parse(parseJson(value.artifactsJson)),
    outcome: value.outcome,
    ...(value.submissionKey === null ? {} : { submissionKey: value.submissionKey }),
    ...(value.bindingJson === null ? {} : { binding: objectSchema.parse(parseJson(value.bindingJson)) }),
    createdAt: value.createdAt,
  };
}

const resultSelect = `SELECT id, workspace_id AS workspaceId, task_id AS taskId,
  attempt_id AS attemptId, author_id AS authorId, summary,
  limitations_json AS limitationsJson, reference_ids_json AS referenceIdsJson,
  evidence_json AS evidenceJson,artifacts_json AS artifactsJson,outcome,
  submission_key AS submissionKey,submission_digest AS submissionDigest,
  binding_json AS bindingJson,created_at AS createdAt FROM results`;

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
    readonly artifacts: readonly object[];
    readonly outcome: ResultView["outcome"];
    readonly submissionKey?: string;
    readonly submissionDigest?: string;
    readonly binding?: Readonly<Record<string, unknown>>;
  }): ResultView {
    if (input.submissionKey !== undefined) {
      const existing = this.bySubmissionKey(input.workspaceId, input.attemptId, input.submissionKey);
      if (existing !== undefined) {
        const stored = this.submissionDigest(input.workspaceId, input.attemptId, input.submissionKey);
        if (input.submissionDigest === undefined || stored !== input.submissionDigest) {
          throw conflict("result_submission_conflict", "Submission key already binds a different canonical result.");
        }
        return existing;
      }
    }
    const id = newId("result");
    this.database.prepare(`INSERT INTO results
      (id, workspace_id, task_id, attempt_id, author_id, summary, limitations_json,
       reference_ids_json,evidence_json,artifacts_json,outcome,submission_key,submission_digest,
       binding_json,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.workspaceId, input.taskId, input.attemptId, input.authorId, input.summary,
        JSON.stringify(input.limitations), JSON.stringify(input.referenceIds),
        JSON.stringify(input.evidence), JSON.stringify(input.artifacts), input.outcome,
        input.submissionKey ?? null, input.submissionDigest ?? null,
        input.binding === undefined ? null : JSON.stringify(input.binding), this.clock.now().toISOString());
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
  forTask(workspaceId: string, taskId: string): readonly ResultView[] { return this.database.prepare(`${resultSelect} WHERE workspace_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 100`).all(workspaceId, taskId).map(toResult); }
  forAttempts(workspaceId: string, attemptIds: readonly string[]): readonly ResultView[] {
    if (attemptIds.length === 0) return [];
    return this.database.prepare(`${resultSelect} WHERE workspace_id = ? AND attempt_id IN (${attemptIds.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 100`).all(workspaceId, ...attemptIds).map(toResult);
  }
  recent(workspaceId: string, limit: number): readonly ResultView[] { return this.database.prepare(`${resultSelect} WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`).all(workspaceId, limit).map(toResult); }
  bySubmissionKey(workspaceId: string, attemptId: string, submissionKey: string): ResultView | undefined {
    const row = this.database.prepare(`${resultSelect} WHERE workspace_id=? AND attempt_id=? AND submission_key=?`)
      .get(workspaceId, attemptId, submissionKey);
    return row === undefined ? undefined : toResult(row);
  }
  private submissionDigest(workspaceId: string, attemptId: string, submissionKey: string): string | null {
    const row = z.object({ submissionDigest: z.string().nullable() }).parse(this.database.prepare(
      `SELECT submission_digest AS submissionDigest FROM results
       WHERE workspace_id=? AND attempt_id=? AND submission_key=?`,
    ).get(workspaceId, attemptId, submissionKey));
    return row.submissionDigest;
  }
}
