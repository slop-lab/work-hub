import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { TaskStatus, TaskView } from "../domain/model.ts";
import type { Clock } from "./codec.ts";
import { newId } from "./codec.ts";

const taskRowSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  revision: z.number(),
  title: z.string(),
  description: z.string(),
  expectedOutcome: z.string().nullable(),
  priority: z.number().nullable(),
  ownerId: z.string().nullable(),
  status: z.union([
    z.literal("backlog"),
    z.literal("active"),
    z.literal("review"),
    z.literal("done"),
    z.literal("canceled"),
  ]),
  businessIntentEpoch: z.number(),
  primaryAttemptId: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type NewTask = {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly expectedOutcome?: string;
  readonly priority?: number;
  readonly ownerId?: string;
};

type TaskChanges = {
  readonly title?: string;
  readonly description?: string;
  readonly expectedOutcome?: string;
  readonly priority?: number | null;
  readonly ownerId?: string | null;
};

function toTask(row: unknown): TaskView {
  const value = taskRowSchema.parse(row);
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    revision: value.revision,
    title: value.title,
    description: value.description,
    ...(value.expectedOutcome === null ? {} : { expectedOutcome: value.expectedOutcome }),
    ...(value.priority === null ? {} : { priority: value.priority }),
    ...(value.ownerId === null ? {} : { ownerId: value.ownerId }),
    status: value.status,
    businessIntentEpoch: value.businessIntentEpoch,
    ...(value.primaryAttemptId === null ? {} : { primaryAttemptId: value.primaryAttemptId }),
    ...(value.archivedAt === null ? {} : { archivedAt: value.archivedAt }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

const taskSelect = `SELECT id, workspace_id AS workspaceId, project_id AS projectId,
  revision, title, description, expected_outcome AS expectedOutcome, priority,
  owner_id AS ownerId, status, business_intent_epoch AS businessIntentEpoch,
  primary_attempt_id AS primaryAttemptId, archived_at AS archivedAt,
  created_at AS createdAt, updated_at AS updatedAt FROM tasks`;

export class WorkRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  createTask(input: NewTask): TaskView {
    const id = newId("task");
    const now = this.clock.now().toISOString();
    this.database
      .prepare(
        `INSERT INTO tasks
          (id, workspace_id, project_id, revision, title, description, expected_outcome,
           priority, owner_id, status, business_intent_epoch, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'backlog', 0, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.projectId,
        input.title,
        input.description ?? "",
        input.expectedOutcome ?? null,
        input.priority ?? null,
        input.ownerId ?? null,
        now,
        now,
      );
    return this.getTask(input.workspaceId, id);
  }

  getTask(workspaceId: string, id: string): TaskView {
    return toTask(
      this.database.prepare(`${taskSelect} WHERE workspace_id = ? AND id = ?`).get(workspaceId, id),
    );
  }

  listTasks(workspaceId: string): readonly TaskView[] {
    return this.database
      .prepare(`${taskSelect} WHERE workspace_id = ? ORDER BY priority DESC, updated_at DESC, id`)
      .all(workspaceId)
      .map(toTask);
  }

  updateTask(workspaceId: string, id: string, changes: TaskChanges): TaskView {
    const current = this.getTask(workspaceId, id);
    const now = this.clock.now().toISOString();
    this.database
      .prepare(
        `UPDATE tasks SET revision = revision + 1, title = ?, description = ?,
         expected_outcome = ?, priority = ?, owner_id = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        changes.title ?? current.title,
        changes.description ?? current.description,
        changes.expectedOutcome ?? current.expectedOutcome ?? null,
        changes.priority === undefined ? current.priority ?? null : changes.priority,
        changes.ownerId === undefined ? current.ownerId ?? null : changes.ownerId,
        now,
        workspaceId,
        id,
      );
    return this.getTask(workspaceId, id);
  }

  setStatus(workspaceId: string, id: string, status: TaskStatus): TaskView {
    const now = this.clock.now().toISOString();
    this.database
      .prepare(
        `UPDATE tasks SET revision = revision + 1, status = ?,
         business_intent_epoch = business_intent_epoch + 1, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(status, now, workspaceId, id);
    return this.getTask(workspaceId, id);
  }

  archive(workspaceId: string, id: string): TaskView {
    const now = this.clock.now().toISOString();
    this.database
      .prepare(
        `UPDATE tasks SET revision = revision + 1, archived_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(now, now, workspaceId, id);
    return this.getTask(workspaceId, id);
  }

  addEntry(workspaceId: string, taskId: string, authorId: string, type: string, body: unknown): string {
    const id = newId("entry");
    this.database
      .prepare(
        `INSERT INTO task_entries
          (id, workspace_id, task_id, author_id, entry_type, body_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, workspaceId, taskId, authorId, type, JSON.stringify(body), this.clock.now().toISOString());
    return id;
  }

  validateSelectedReferences(workspaceId: string, taskId: string, referenceIds: readonly string[]): boolean {
    if (referenceIds.length === 0) return true;
    const statement = this.database.prepare(`SELECT 1 FROM references_store
      WHERE workspace_id = ? AND id = ? AND task_id = ? AND availability <> 'unavailable'`);
    return referenceIds.every((id) => statement.get(workspaceId, id, taskId) !== undefined);
  }
}
