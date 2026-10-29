import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { Store } from "../../application/persistence/database.ts";
import { LifecycleRepository } from "../../application/persistence/lifecycle-repository.ts";
import { createTask, delegateNone, finishAttempt, fixture, member } from "../acceptance-fixture.ts";

test("acceptance epoch migration preserves terminal decisions and fences reopened decisions", async () => {
  const context = fixture();
  const acceptedTaskId = await createAcceptedTask(context, "migration-terminal");
  const reopenedTaskId = await createAcceptedTask(context, "migration-reopened");
  await context.hub.execute(member, { commandId: "migration-reopen", type: "task.setStatus",
    target: { kind: "task", id: reopenedTaskId },
    expected: { task: context.hub.getTask(member, reopenedTaskId).revision }, payload: { status: "backlog" } });
  context.hub.close();
  try {
    const legacy = new DatabaseSync(context.path);
    legacy.exec(`ALTER TABLE result_acceptances RENAME TO result_acceptances_current;
      CREATE TABLE result_acceptances (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
        result_id TEXT NOT NULL, actor_id TEXT NOT NULL, decision TEXT NOT NULL,
        missing_criteria_json TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
      INSERT INTO result_acceptances
        (id,workspace_id,task_id,result_id,actor_id,decision,missing_criteria_json,note,created_at)
        SELECT id,workspace_id,task_id,result_id,actor_id,decision,missing_criteria_json,note,created_at
        FROM result_acceptances_current;
      DROP TABLE result_acceptances_current;`);
    legacy.close();

    const migrated = new Store(context.path);
    try {
      const lifecycle = new LifecycleRepository(migrated.database, migrated.clock);
      assert.equal(lifecycle.view(member.workspaceId, acceptedTaskId).acceptance?.decision, "accepted");
      assert.equal(lifecycle.view(member.workspaceId, reopenedTaskId).acceptance, undefined);
      assert.equal(lifecycle.view(member.workspaceId, reopenedTaskId).projection.currentMissingAction,
        "delegate_or_submit");
    } finally { migrated.close(); }
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});

async function createAcceptedTask(context: ReturnType<typeof fixture>, suffix: string): Promise<string> {
  const taskId = await createTask(context.hub, suffix);
  const attempt = await delegateNone(context.hub, taskId, suffix);
  const submitted = await context.hub.execute(member, { commandId: `result-${suffix}`, type: "result.submit",
    target: { kind: "attempt", id: attempt.id }, payload: { kind: "final", summary: "Accepted result",
      limitations: [], referenceIds: [], evidence: [], criterionEvidence: [] } });
  const resultId = submitted.objectRefs[0]?.id;
  assert.ok(resultId);
  await finishAttempt(context.hub, attempt);
  const accepted = await context.hub.execute(member, { commandId: `accept-${suffix}`, type: "task.acceptResult",
    target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision },
    payload: { resultId, decision: "accepted", missingCriteria: [] } });
  assert.equal(accepted.status, "confirmed");
  return taskId;
}
