import { DatabaseSync } from "node:sqlite";

import type { Clock } from "./codec.ts";
import { systemClock } from "./codec.ts";
import { migrate } from "./migrations.ts";

export class Store {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  private transactionDepth = 0;

  constructor(path: string, clock: Clock = systemClock) {
    this.database = new DatabaseSync(path);
    this.clock = clock;
    migrate(this.database);
    this.seed();
  }

  transaction<T>(work: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `work_hub_${depth}`;
    this.database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = work();
      this.transactionDepth -= 1;
      this.database.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (depth === 0) {
        this.database.exec("ROLLBACK");
      } else {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private seed(): void {
    const now = this.clock.now().toISOString();
    const userStatement = this.database.prepare(
      `INSERT OR IGNORE INTO users
        (id, workspace_id, subject, display_name, role, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    userStatement.run("user-admin", "workspace-default", "admin", "Administrator", "administrator", now, now);
    userStatement.run("user-member", "workspace-default", "member", "Member", "member", now, now);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO projects
          (id, workspace_id, revision, name, default_profile_id, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        "project-default",
        "workspace-default",
        "Default project",
        "profile-structured",
        now,
        now,
      );
    const profiles = [
      ["profile-structured", "Structured simulator", "runtime-sim-structured", ["createSession", "structuredInput", "nativeQuestions", "nativeApprovals", "resultReporting"]],
      ["profile-limited", "Limited bridge simulator", "runtime-sim-limited", ["createSession", "structuredInput", "requestBridge", "resultReporting"]],
    ] as const;
    const statement = this.database.prepare(
      `INSERT OR IGNORE INTO execution_profiles
        (id, revision, workspace_id, label, enabled, runtime_installation_id,
         configuration_json, allowed_environment_modes_json, default_environment_json,
         required_capabilities_json, allowed_effects_json, created_at)
       VALUES (?, 1, ?, ?, 1, ?, '{}', '["provision","existing","none"]',
         '{"mode":"none"}', ?, '["task.read","work.write"]', ?)`,
    );
    for (const [id, label, installationId, capability] of profiles) {
      statement.run(
        id,
        "workspace-default",
        label,
        installationId,
        JSON.stringify(capability),
        now,
      );
    }
  }
}
