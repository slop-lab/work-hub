import assert from "node:assert/strict";
import { test } from "node:test";

import { createTask, delegateNone, finishAttempt, fixture, member } from "../acceptance-fixture.ts";

test("accepted result requires an explicit active-work decision when its attempt is unresolved", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "accepted-active-decision");
    const attempt = await delegateNone(context.hub, taskId, "accepted-active-decision");
    const submitted = await context.hub.execute(member, {
      commandId: "result-accepted-active-decision",
      type: "result.submit",
      target: { kind: "attempt", id: attempt.id },
      payload: {
        kind: "final",
        summary: "Reviewable while execution remains active.",
        limitations: [],
        referenceIds: [],
        evidence: [],
        criterionEvidence: [],
      },
    });
    const resultId = submitted.objectRefs[0]?.id;
    assert.ok(resultId);

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "accept-active-without-decision",
      type: "task.acceptResult",
      target: { kind: "task", id: taskId },
      expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { resultId, decision: "accepted", missingCriteria: [] },
    });

    // Then
    assert.equal(receipt.error?.code, "active_execution_requires_decision");
    assert.equal(context.hub.getTask(member, taskId).status, "active");
  } finally {
    context.close();
  }
});

test("accepted result can request stop through the same active-work completion semantics", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "accepted-active-stop");
    const attempt = await delegateNone(context.hub, taskId, "accepted-active-stop");
    const submitted = await context.hub.execute(member, {
      commandId: "result-accepted-active-stop",
      type: "result.submit",
      target: { kind: "attempt", id: attempt.id },
      payload: {
        kind: "final",
        summary: "Human acceptance should request a separate stop.",
        limitations: [],
        referenceIds: [],
        evidence: [],
        criterionEvidence: [],
      },
    });
    const resultId = submitted.objectRefs[0]?.id;
    assert.ok(resultId);

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "accept-active-with-stop",
      type: "task.acceptResult",
      target: { kind: "task", id: taskId },
      expected: { task: context.hub.getTask(member, taskId).revision },
      payload: {
        resultId,
        decision: "accepted",
        missingCriteria: [],
        activeExecutionDecision: "request_stop",
      },
    });

    // Then
    assert.equal(receipt.status, "confirmed");
    assert.equal(receipt.operationIds.length, 1);
    assert.ok(context.hub.snapshot(member).attempts.find((candidate) => candidate.id === attempt.id)?.stopRequestedAt);
  } finally {
    context.close();
  }
});

test("verification-required criterion cannot be accepted from a bare satisfied flag", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "verification-reference-required");
    await context.hub.execute(member, {
      commandId: "amend-verification-reference-required",
      type: "task.amend",
      target: { kind: "task", id: taskId },
      expected: { task: 1 },
      payload: {
        summary: "Require retained verification evidence.",
        criteria: [{
          key: "focused-verification",
          description: "Focused verification passes.",
          requirement: "required",
          verification: "required",
        }],
        supersedesCriterionIds: [],
      },
    });
    const criterionId = context.hub.getTaskLifecycle(member, taskId).criteria[0]?.id;
    assert.ok(criterionId);
    const attempt = await delegateNone(context.hub, taskId, "verification-reference-required");
    const submitted = await context.hub.execute(member, {
      commandId: "result-verification-reference-required",
      type: "result.submit",
      target: { kind: "attempt", id: attempt.id },
      payload: {
        kind: "final",
        summary: "Claims verification without retaining its evidence.",
        limitations: [],
        referenceIds: [],
        evidence: [],
        criterionEvidence: [{
          criterionId,
          status: "satisfied",
          detail: "The suite passed.",
          referenceIds: [],
        }],
      },
    });
    const resultId = submitted.objectRefs[0]?.id;
    assert.ok(resultId);
    await finishAttempt(context.hub, attempt);

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "accept-verification-without-reference",
      type: "task.acceptResult",
      target: { kind: "task", id: taskId },
      expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { resultId, decision: "accepted", missingCriteria: [] },
    });

    // Then
    assert.equal(receipt.error?.code, "acceptance_criteria_missing");
    assert.deepEqual(context.hub.getTaskLifecycle(member, taskId).projection.criterionCoverage.missing, [criterionId]);
  } finally {
    context.close();
  }
});

test("accepted terminal task rejects a later scope amendment", async () => {
  // Given
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "terminal-amendment");
    const attempt = await delegateNone(context.hub, taskId, "terminal-amendment");
    const submitted = await context.hub.execute(member, {
      commandId: "result-terminal-amendment",
      type: "result.submit",
      target: { kind: "attempt", id: attempt.id },
      payload: {
        kind: "final",
        summary: "Accepted terminal result.",
        limitations: [],
        referenceIds: [],
        evidence: [],
        criterionEvidence: [],
      },
    });
    const resultId = submitted.objectRefs[0]?.id;
    assert.ok(resultId);
    await finishAttempt(context.hub, attempt);
    const accepted = await context.hub.execute(member, {
      commandId: "accept-terminal-amendment",
      type: "task.acceptResult",
      target: { kind: "task", id: taskId },
      expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { resultId, decision: "accepted", missingCriteria: [] },
    });
    assert.equal(accepted.status, "confirmed");

    // When
    const receipt = await context.hub.execute(member, {
      commandId: "amend-after-terminal-acceptance",
      type: "task.amend",
      target: { kind: "task", id: taskId },
      expected: { task: context.hub.getTask(member, taskId).revision },
      payload: {
        summary: "Do not silently expand accepted scope.",
        criteria: [{
          key: "late-required-scope",
          description: "Late required work.",
          requirement: "required",
          verification: "optional",
        }],
        supersedesCriterionIds: [],
      },
    });

    // Then
    assert.equal(receipt.error?.code, "terminal_scope_accepted");
    assert.equal(context.hub.getTaskLifecycle(member, taskId).criteria.length, 0);
    assert.equal(context.hub.getTask(member, taskId).status, "done");
  } finally {
    context.close();
  }
});

test("accepted terminal task rejects a task brief edit that would replace its scope", async () => {
  const context = fixture();
  try {
    const taskId = await createTask(context.hub, "terminal-brief-edit");
    const attempt = await delegateNone(context.hub, taskId, "terminal-brief-edit");
    const submitted = await context.hub.execute(member, {
      commandId: "result-terminal-brief-edit",
      type: "result.submit",
      target: { kind: "attempt", id: attempt.id },
      payload: { kind: "final", summary: "Accepted terminal result.", limitations: [],
        referenceIds: [], evidence: [], criterionEvidence: [] },
    });
    const resultId = submitted.objectRefs[0]?.id;
    assert.ok(resultId);
    await finishAttempt(context.hub, attempt);
    const accepted = await context.hub.execute(member, {
      commandId: "accept-terminal-brief-edit",
      type: "task.acceptResult",
      target: { kind: "task", id: taskId },
      expected: { task: context.hub.getTask(member, taskId).revision },
      payload: { resultId, decision: "accepted", missingCriteria: [] },
    });
    assert.equal(accepted.status, "confirmed");
    const acceptedTask = context.hub.getTask(member, taskId);

    const receipt = await context.hub.execute(member, {
      commandId: "edit-terminal-brief",
      type: "task.update",
      target: { kind: "task", id: taskId },
      expected: { task: acceptedTask.revision },
      payload: { title: "Silently replaced scope" },
    });

    assert.equal(receipt.error?.code, "terminal_scope_accepted");
    assert.equal(context.hub.getTask(member, taskId).title, acceptedTask.title);
    assert.equal(context.hub.getTask(member, taskId).scopeRevision, acceptedTask.scopeRevision);
  } finally {
    context.close();
  }
});
