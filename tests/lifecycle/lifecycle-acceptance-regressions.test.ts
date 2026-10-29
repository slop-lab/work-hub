import assert from "node:assert/strict";
import { test } from "node:test";

import { createTask, delegateNone, finishAttempt, fixture, member } from "../acceptance-fixture.ts";

test("accepted result evidence remains authoritative when active execution submits a later result", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "accepted-result-anchor");
    await context.hub.execute(member, { commandId: "amend-accepted-result-anchor", type: "task.amend",
      target: { kind: "task", id: taskId }, expected: { task: 1 }, payload: {
        summary: "Retain accepted evidence.", supersedesCriterionIds: [], criteria: [{
          key: "anchored", description: "Accepted evidence remains anchored.",
          requirement: "required", verification: "optional",
        }],
      } });
    const criterionId = context.hub.getTaskLifecycle(member, taskId).criteria[0]?.id;
    assert.ok(criterionId);
    const attempt = await delegateNone(context.hub, taskId, "accepted-result-anchor");
    const first = await context.hub.execute(member, { commandId: "result-accepted-anchor", type: "result.submit",
      target: { kind: "attempt", id: attempt.id }, payload: { kind: "final", summary: "Accepted result",
        limitations: [], referenceIds: [], evidence: [], criterionEvidence: [{ criterionId,
          status: "satisfied", detail: "Accepted evidence.", referenceIds: [] }] } });
    const acceptedResultId = first.objectRefs[0]?.id;
    assert.ok(acceptedResultId);
    const accepted = await context.hub.execute(member, { commandId: "accept-result-anchor", type: "task.acceptResult",
      target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { resultId: acceptedResultId, decision: "accepted", missingCriteria: [],
        activeExecutionDecision: "allow_to_continue" } });
    assert.equal(accepted.status, "confirmed");

    const later = await context.hub.execute(member, { commandId: "later-result-after-acceptance", type: "result.submit",
      target: { kind: "attempt", id: attempt.id }, payload: { kind: "final", summary: "Later unaccepted result",
        limitations: [], referenceIds: [], evidence: [], criterionEvidence: [{ criterionId,
          status: "not_satisfied", detail: "Later evidence regressed.", referenceIds: [] }] } });
    assert.equal(later.status, "confirmed");

    const lifecycle = context.hub.getTaskLifecycle(member, taskId);
    assert.equal(lifecycle.acceptance?.resultId, acceptedResultId);
    assert.equal(lifecycle.projection.currentMissingAction, "none");
    assert.equal(lifecycle.projection.criterionCoverage.satisfied, 1);
  } finally { context.close(); }
});

test("reopening an accepted task hides its terminal acceptance and requires new work", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "accepted-reopen");
    const attempt = await delegateNone(context.hub, taskId, "accepted-reopen");
    const submitted = await context.hub.execute(member, { commandId: "result-accepted-reopen", type: "result.submit",
      target: { kind: "attempt", id: attempt.id }, payload: { kind: "final", summary: "Accepted result",
        limitations: [], referenceIds: [], evidence: [], criterionEvidence: [] } });
    const resultId = submitted.objectRefs[0]?.id;
    assert.ok(resultId);
    await finishAttempt(context.hub, attempt);
    await context.hub.execute(member, { commandId: "accept-reopen", type: "task.acceptResult",
      target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { resultId, decision: "accepted", missingCriteria: [] } });

    const reopened = await context.hub.execute(member, { commandId: "reopen-accepted", type: "task.setStatus",
      target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { status: "backlog" } });

    assert.equal(reopened.status, "confirmed");
    const lifecycle = context.hub.getTaskLifecycle(member, taskId);
    assert.equal(lifecycle.acceptance, undefined);
    assert.equal(lifecycle.projection.currentMissingAction, "delegate_or_submit");

    const nextAttempt = await delegateNone(context.hub, taskId, "accepted-reopen-next");
    const nextResult = await context.hub.execute(member, { commandId: "result-after-reopen", type: "result.submit",
      target: { kind: "attempt", id: nextAttempt.id }, payload: { kind: "final", summary: "New result after reopen.",
        limitations: [], referenceIds: [], evidence: [], criterionEvidence: [] } });
    assert.equal(nextResult.status, "confirmed");
    const activeLifecycle = context.hub.getTaskLifecycle(member, taskId);
    assert.equal(activeLifecycle.acceptance, undefined);
    assert.equal(activeLifecycle.projection.currentMissingAction, "review_result");
  } finally { context.close(); }
});

test("re-completing a reopened task does not revive its old acceptance", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "accepted-recomplete");
    const attempt = await delegateNone(context.hub, taskId, "accepted-recomplete");
    const submitted = await context.hub.execute(member, { commandId: "result-accepted-recomplete", type: "result.submit",
      target: { kind: "attempt", id: attempt.id }, payload: { kind: "final", summary: "Accepted result",
        limitations: [], referenceIds: [], evidence: [], criterionEvidence: [] } });
    const resultId = submitted.objectRefs[0]?.id;
    assert.ok(resultId);
    await finishAttempt(context.hub, attempt);
    await context.hub.execute(member, { commandId: "accept-recomplete", type: "task.acceptResult",
      target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { resultId, decision: "accepted", missingCriteria: [] } });
    await context.hub.execute(member, { commandId: "reopen-recomplete", type: "task.setStatus",
      target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { status: "backlog" } });
    await context.hub.execute(member, { commandId: "complete-reopened-without-acceptance", type: "task.setStatus",
      target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { status: "done" } });

    assert.equal(context.hub.getTaskLifecycle(member, taskId).acceptance, undefined);
  } finally { context.close(); }
});

test("criteria-free task completed without execution rejects later scope replacement", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "ordinary-terminal-edit");
    const completed = await context.hub.execute(member, { commandId: "complete-ordinary-terminal", type: "task.setStatus",
      target: { kind: "task", id: taskId }, expected: { task: 1 }, payload: { status: "done" } });
    assert.equal(completed.status, "confirmed");

    const edited = await context.hub.execute(member, { commandId: "edit-ordinary-terminal", type: "task.update",
      target: { kind: "task", id: taskId }, expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { title: "Replaced after completion" } });

    assert.equal(edited.error?.code, "terminal_scope_accepted");
    assert.equal(context.hub.getTask(member, taskId).title, "Acceptance ordinary-terminal-edit");
  } finally { context.close(); }
});
