import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTask,
  delegateNone,
  finishAttempt,
  fixture,
  member,
} from "../acceptance-fixture.ts";

test("task amendments preserve criterion history and final acceptance requires current evidence", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "lifecycle-criteria");
    const amended = await f.hub.execute(member, {
      commandId: "amend-lifecycle-criteria",
      type: "task.amend",
      target: { kind: "task", id: taskId },
      expected: { task: 1 },
      payload: {
        summary: "Require the focused service suite.",
        criteria: [{
          key: "focused-tests",
          description: "Focused lifecycle service tests pass.",
          requirement: "required",
          verification: "required",
        }],
        supersedesCriterionIds: [],
      },
    });
    assert.equal(amended.status, "confirmed");
    const attempt = await delegateNone(f.hub, taskId, "lifecycle-criteria");
    const checkpoint = await f.hub.execute(member, {
      commandId: "checkpoint-lifecycle-criteria",
      type: "result.submit",
      target: { kind: "attempt", id: attempt.id },
      payload: {
        kind: "checkpoint",
        summary: "Implementation is ready for verification.",
        limitations: ["Focused suite not run yet."],
        referenceIds: [],
        evidence: [],
        criterionEvidence: [],
      },
    });
    const checkpointId = checkpoint.objectRefs[0]?.id;
    assert.ok(checkpointId);
    const rejectedCheckpoint = await f.hub.execute(member, {
      commandId: "accept-checkpoint-lifecycle-criteria",
      type: "task.acceptResult",
      target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision },
      payload: { resultId: checkpointId, decision: "accepted", missingCriteria: [] },
    });
    assert.equal(rejectedCheckpoint.error?.code, "result_not_final");
    const criterionId = f.hub.getTaskLifecycle(member, taskId).criteria[0]?.id;
    assert.ok(criterionId);
    const reference = await f.hub.execute(member, {
      commandId: "reference-lifecycle-criteria",
      type: "reference.create",
      target: { kind: "task", id: taskId },
      payload: { kind: "text", title: "Focused lifecycle test receipt", content: "Focused suite passed." },
    });
    const referenceId = reference.objectRefs[0]?.id;
    assert.ok(referenceId);
    const final = await f.hub.execute(member, {
      commandId: "final-lifecycle-criteria",
      type: "result.submit",
      target: { kind: "attempt", id: attempt.id },
      payload: {
        kind: "final",
        summary: "Focused suite passed.",
        limitations: [],
        referenceIds: [referenceId],
        evidence: [],
        criterionEvidence: [{
          criterionId,
          status: "satisfied",
          detail: "The focused service suite completed successfully.",
          referenceIds: [referenceId],
        }],
      },
    });
    const finalId = final.objectRefs[0]?.id;
    assert.ok(finalId);
    await finishAttempt(f.hub, attempt);

    // When
    const obsolete = await f.hub.execute(member, {
      commandId: "accept-obsolete-lifecycle-criteria",
      type: "task.acceptResult",
      target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision },
      payload: { resultId: checkpointId, decision: "accepted", missingCriteria: [] },
    });
    const bypass = await f.hub.execute(member, { commandId: "bypass-acceptance-lifecycle-criteria",
      type: "task.setStatus", target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision },
      payload: { status: "done", resultId: finalId, completionNote: "Do not bypass acceptance." } });
    const accepted = await f.hub.execute(member, {
      commandId: "accept-final-lifecycle-criteria",
      type: "task.acceptResult",
      target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision },
      payload: { resultId: finalId, decision: "accepted", missingCriteria: [] },
    });

    // Then
    assert.equal(obsolete.error?.code, "result_obsolete");
    assert.equal(bypass.error?.code, "acceptance_required");
    assert.equal(accepted.status, "confirmed");
    assert.equal(f.hub.getTask(member, taskId).status, "done");
    const lifecycle = f.hub.getTaskLifecycle(member, taskId);
    assert.equal(lifecycle.amendments.length, 1);
    assert.equal(lifecycle.acceptance?.decision, "accepted");
    assert.deepEqual(lifecycle.acceptance?.missingCriteria, []);
    assert.equal(lifecycle.projection.currentMissingAction, "none");
  } finally {
    f.close();
  }
});

test("incomplete acceptance persists explicit missing criteria without completing the task", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "lifecycle-incomplete");
    await f.hub.execute(member, {
      commandId: "amend-lifecycle-incomplete",
      type: "task.amend",
      target: { kind: "task", id: taskId },
      expected: { task: 1 },
      payload: {
        summary: "Require exact-source verification.",
        criteria: [{ key: "exact-source", description: "Verify the selected source.", requirement: "required", verification: "required" }],
        supersedesCriterionIds: [],
      },
    });
    const attempt = await delegateNone(f.hub, taskId, "lifecycle-incomplete");
    const result = await f.hub.execute(member, {
      commandId: "result-lifecycle-incomplete",
      type: "result.submit",
      target: { kind: "attempt", id: attempt.id },
      payload: { kind: "final", summary: "Verification is pending.", limitations: ["No verifier evidence."], referenceIds: [], evidence: [], criterionEvidence: [] },
    });
    const resultId = result.objectRefs[0]?.id;
    const criterionId = f.hub.getTaskLifecycle(member, taskId).criteria[0]?.id;
    assert.ok(resultId);
    assert.ok(criterionId);
    await finishAttempt(f.hub, attempt);
    const incompatibleDone = await f.hub.execute(member, {
      commandId: "done-lifecycle-incomplete",
      type: "task.setStatus",
      target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision },
      payload: { status: "done", resultId, completionNote: "Do not bypass missing criteria." },
    });
    assert.equal(incompatibleDone.error?.code, "acceptance_criteria_missing");

    // When
    const receipt = await f.hub.execute(member, {
      commandId: "incomplete-lifecycle-incomplete",
      type: "task.acceptResult",
      target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision },
      payload: { resultId, decision: "incomplete", missingCriteria: [criterionId], note: "Run the verifier." },
    });

    // Then
    assert.equal(receipt.status, "confirmed");
    assert.equal(f.hub.getTask(member, taskId).status, "review");
    assert.equal(f.hub.getTaskLifecycle(member, taskId).projection.currentMissingAction, "revise_result");
    assert.deepEqual(f.hub.getTaskLifecycle(member, taskId).acceptance?.missingCriteria, [criterionId]);
  } finally {
    f.close();
  }
});

test("late non-primary results cannot replace the current lifecycle projection", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "lifecycle-late-result");
    const first = await delegateNone(f.hub, taskId, "lifecycle-late-result-first");
    await finishAttempt(f.hub, first, "failed");
    const retry = await f.hub.execute(member, { commandId: "lifecycle-late-result-retry",
      type: "attempt.retry", target: { kind: "attempt", id: first.id },
      expected: { task: f.hub.getTask(member, taskId).revision, profile: 1 },
      payload: { predecessorId: first.id, input: "current_task", sameSession: false,
        reason: "Retry current work.", retryLimit: 2, environment: { mode: "none" } } });
    const currentId = retry.objectRefs[0]?.id;
    assert.ok(currentId);

    // When
    await f.hub.execute(member, { commandId: "lifecycle-late-result-submit", type: "result.submit",
      target: { kind: "attempt", id: first.id }, payload: { kind: "final",
        summary: "Late obsolete result.", limitations: [], referenceIds: [], evidence: [], criterionEvidence: [] } });

    // Then
    const task = f.hub.getTask(member, taskId);
    assert.equal(task.primaryAttemptId, currentId);
    assert.equal(f.hub.getTaskLifecycle(member, taskId).projection.currentMissingAction, "await_execution");
  } finally { f.close(); }
});
