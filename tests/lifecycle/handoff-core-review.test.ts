import assert from "node:assert/strict";
import { test } from "node:test";

import { HandoffRepository } from "../../application/persistence/handoff-repository.ts";
import { Store } from "../../application/persistence/database.ts";
import { createTask, drainIdle, finishAttempt, fixture, member } from "../acceptance-fixture.ts";

const sourceCommit = "a".repeat(40);

test("handoff preview derives context digest from bound selections and delegation must match", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "handoff-server-context");
    const reference = await f.hub.execute(member, {
      commandId: "reference-handoff-server-context",
      type: "reference.create",
      target: { kind: "task", id: taskId },
      payload: { kind: "text", title: "Verifier instructions", content: "Run the lifecycle suite." },
    });
    const referenceId = reference.objectRefs[0]?.id;
    assert.ok(referenceId);
    const repository = f.hub.registerProjectRepository(member, {
      projectId: "project-default", canonicalIdentity: "https://example.invalid/org/context.git",
    });
    const preview = f.hub.previewHandoff(member, {
      taskId, profileId: "profile-structured", repositoryId: repository.id,
      repositoryRevision: repository.revision, sourceBranch: "work/context", sourceCommit,
      requestedValidation: "Focused lifecycle suite", selectedReferenceIds: [referenceId],
      selectedResponseIds: [], recipient: { kind: "new" },
    });

    // When
    const mismatched = await f.hub.execute(member, {
      commandId: "delegate-handoff-server-context",
      type: "attempt.delegate",
      target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision, profile: 1 },
      payload: {
        profileId: "profile-structured", environment: { mode: "none" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
        handoff: { previewDigest: preview.previewDigest, verification: preview.verification,
          recipient: { kind: "new" } },
      },
    });

    // Then
    assert.match(preview.verification.contextDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(mismatched.error?.code, "handoff_selection_mismatch");
  } finally {
    f.close();
  }
});

test("repository identities reject embedded credentials and query material", () => {
  // Given
  const f = fixture();
  try {
    // When / Then
    assert.throws(() => f.hub.registerProjectRepository(member, {
      projectId: "project-default",
      canonicalIdentity: "https://user:secret@example.invalid/org/repo.git",
    }), /credential/i);
    assert.throws(() => f.hub.registerProjectRepository(member, {
      projectId: "project-default",
      canonicalIdentity: "https://example.invalid/org/repo.git?token=secret",
    }), /credential/i);
  } finally {
    f.close();
  }
});

test("attempt delivery acknowledgment is monotonic", () => {
  // Given
  const store = new Store(":memory:");
  try {
    const repository = new HandoffRepository(store.database, store.clock);
    const now = store.clock.now().toISOString();
    store.database.prepare(`INSERT INTO attempt_deliveries
      (attempt_id,workspace_id,delivery_digest,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`).run("attempt-monotonic", "workspace-default", "digest-monotonic",
      "pending", now, now);
    repository.acknowledge("workspace-default", "attempt-monotonic", "digest-monotonic");

    // When
    repository.recordDelivery("workspace-default", "attempt-monotonic", {
      status: "failed", error: { code: "late_transport_failure" },
    });

    // Then
    assert.equal(repository.delivery("workspace-default", "attempt-monotonic")["status"], "acknowledged");
  } finally {
    store.close();
  }
});

test("verification retry preserves handoff lineage when task scope is unchanged", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "handoff-retry-lineage");
    const repository = f.hub.registerProjectRepository(member, {
      projectId: "project-default", canonicalIdentity: "https://example.invalid/org/retry.git",
    });
    const preview = f.hub.previewHandoff(member, {
      taskId, profileId: "profile-structured", repositoryId: repository.id,
      repositoryRevision: repository.revision, sourceBranch: "work/retry", sourceCommit,
      requestedValidation: "Retry verification", selectedReferenceIds: [],
      selectedResponseIds: [], recipient: { kind: "new" },
    });
    const delegated = await f.hub.execute(member, {
      commandId: "delegate-handoff-retry-lineage", type: "attempt.delegate",
      target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
      payload: { profileId: "profile-structured", environment: { mode: "none" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
        handoff: { previewDigest: preview.previewDigest, verification: preview.verification,
          recipient: { kind: "new" } } },
    });
    await drainIdle(f.hub);
    const sourceAttempt = f.hub.snapshot(member).attempts.find((item) => item.id === delegated.objectRefs[0]?.id);
    assert.ok(sourceAttempt);
    await finishAttempt(f.hub, sourceAttempt, "failed");

    // When
    const retried = await f.hub.execute(member, {
      commandId: "retry-handoff-retry-lineage", type: "attempt.retry",
      target: { kind: "attempt", id: sourceAttempt.id },
      expected: { task: f.hub.getTask(member, taskId).revision, profile: 1 },
      payload: { predecessorId: sourceAttempt.id, input: "snapshot", sameSession: false,
        reason: "Retry the failed verifier.", retryLimit: 2, environment: { mode: "none" } },
    });

    // Then
    assert.equal(retried.status, "accepted");
    const retryId = retried.objectRefs[0]?.id;
    assert.ok(retryId);
    const detail = f.hub.getHandoff(member, retryId);
    assert.equal(detail.preview.previewDigest, preview.previewDigest);
    assert.equal(detail.delivery["status"], "pending");
    assert.equal(detail.attempt.retryOrdinal, 1);
    assert.equal(detail.attempt.profileId, sourceAttempt.profileId);
    assert.equal(detail.attempt.profileRevision, sourceAttempt.profileRevision);
  } finally {
    f.close();
  }
});

test("task amendment requires a fresh handoff preview before retry", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "handoff-amended-retry");
    const repository = f.hub.registerProjectRepository(member, {
      projectId: "project-default", canonicalIdentity: "https://example.invalid/org/amended.git",
    });
    const preview = f.hub.previewHandoff(member, {
      taskId, profileId: "profile-structured", repositoryId: repository.id,
      repositoryRevision: repository.revision, sourceBranch: "work/amended", sourceCommit,
      requestedValidation: "Original verification", selectedReferenceIds: [],
      selectedResponseIds: [], recipient: { kind: "new" },
    });
    const delegated = await f.hub.execute(member, {
      commandId: "delegate-handoff-amended-retry", type: "attempt.delegate",
      target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 },
      payload: { profileId: "profile-structured", environment: { mode: "none" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
        handoff: { previewDigest: preview.previewDigest, verification: preview.verification,
          recipient: { kind: "new" } } },
    });
    await drainIdle(f.hub);
    const sourceAttempt = f.hub.snapshot(member).attempts.find((item) => item.id === delegated.objectRefs[0]?.id);
    assert.ok(sourceAttempt);
    await finishAttempt(f.hub, sourceAttempt, "failed");
    await f.hub.execute(member, {
      commandId: "amend-handoff-amended-retry", type: "task.amend",
      target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision },
      payload: { summary: "Add another required check.", supersedesCriterionIds: [],
        criteria: [{ key: "new-check", description: "Run the new check.",
          requirement: "required", verification: "required" }] },
    });

    // When
    const retried = await f.hub.execute(member, {
      commandId: "retry-handoff-amended-retry", type: "attempt.retry",
      target: { kind: "attempt", id: sourceAttempt.id },
      expected: { task: f.hub.getTask(member, taskId).revision, profile: 1 },
      payload: { predecessorId: sourceAttempt.id, input: "snapshot", sameSession: false,
        reason: "Retry after scope change.", retryLimit: 2, environment: { mode: "none" } },
    });

    // Then
    assert.equal(retried.error?.code, "handoff_fresh_preview_required");
    assert.equal(f.hub.snapshot(member).attempts.length, 1);
  } finally {
    f.close();
  }
});
