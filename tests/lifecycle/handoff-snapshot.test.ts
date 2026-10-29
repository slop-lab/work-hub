import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { digest } from "../../application/persistence/codec.ts";
import { PromptEnvelopeSchema } from "../../application/prompts/index.ts";
import { createTask, delegateNone, finishAttempt, fixture, member } from "../acceptance-fixture.ts";

const sourceCommit = "a".repeat(40);

test("attached handoff preserves selected context and current task scope", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "handoff-attached-context");
    const reference = await f.hub.execute(member, {
      commandId: "reference-handoff-attached-context", type: "reference.create",
      target: { kind: "task", id: taskId },
      payload: { kind: "text", title: "Verifier fixture", content: "Use the retained verifier fixture." },
    });
    const referenceId = reference.objectRefs[0]?.id;
    assert.ok(referenceId);
    const request = await f.hub.execute(member, {
      commandId: "request-handoff-attached-context", type: "request.create",
      payload: { kind: "question", projectId: "project-default", taskId,
        recipient: { kind: "project_members", projectId: "project-default" },
        prompt: "Which verifier target?", referenceIds: [],
        answerSchema: { kind: "text", minLength: 1, maxLength: 100 }, blocking: "none",
        validity: { kind: "task", taskId } },
    });
    const requestId = request.objectRefs[0]?.id;
    assert.ok(requestId);
    const response = await f.hub.execute(member, {
      commandId: "response-handoff-attached-context", type: "request.respond",
      target: { kind: "request", id: requestId }, expected: { request: 1 },
      payload: { answer: { kind: "text", text: "Use the attached verifier." } },
    });
    const responseId = response.objectRefs[0]?.id;
    assert.ok(responseId);
    const predecessor = await delegateNone(f.hub, taskId, "handoff-attached-context-predecessor");
    await finishAttempt(f.hub, predecessor);
    const session = f.hub.getSession(member, predecessor.sessionId).session;
    const task = f.hub.getTask(member, taskId);
    const repository = f.hub.registerProjectRepository(member, {
      projectId: "project-default", canonicalIdentity: "https://example.invalid/org/attached-context.git",
    });
    const recipient = { kind: "attached", sessionId: session.id, sessionRevision: session.revision,
      bindingGeneration: session.bindingGeneration, profileId: "profile-structured", profileRevision: 1 } as const;
    const preview = f.hub.previewHandoff(member, {
      taskId, profileId: "profile-structured", repositoryId: repository.id,
      repositoryRevision: repository.revision, sourceBranch: "work/attached-context", sourceCommit,
      requestedValidation: "Verify attached context", selectedReferenceIds: [referenceId],
      selectedResponseIds: [responseId], recipient,
    });

    // When
    const delegated = await f.hub.execute(member, {
      commandId: "delegate-handoff-attached-context", type: "attempt.delegate",
      target: { kind: "task", id: taskId }, expected: { task: task.revision, profile: 1 },
      payload: { profileId: "profile-structured", environment: { mode: "none" },
        selectedReferenceIds: [referenceId], selectedResponseIds: [responseId], authorizedEffectKinds: [],
        handoff: { previewDigest: preview.previewDigest, verification: preview.verification, recipient } },
    });

    // Then
    assert.equal(delegated.status, "accepted", JSON.stringify(delegated.error));
    const attemptId = delegated.objectRefs[0]?.id;
    assert.ok(attemptId);
    const snapshot = f.hub.getHandoff(member, attemptId).attempt.inputSnapshot;
    assert.deepEqual(snapshot["selectedReferenceIds"], [referenceId]);
    assert.deepEqual(snapshot["selectedResponseIds"], [responseId]);
    assert.equal(snapshot["scopeRevision"], task.scopeRevision);
    const instruction = z.string().parse(snapshot["instruction"]);
    assert.equal(snapshot["promptDigest"], digest(instruction));
    const envelope = PromptEnvelopeSchema.parse(JSON.parse(instruction));
    assert.deepEqual(snapshot["promptTemplate"], {
      id: "verifier_handoff", version: 1, inputDigest: digest(envelope.input),
    });
    const contextItems = z.array(z.object({ sourceId: z.string(), includedText: z.string().optional() }))
      .parse(snapshot["contextItems"]);
    assert.match(contextItems.find((item) => item.sourceId === referenceId)?.includedText ?? "",
      /retained verifier fixture/);
    assert.match(contextItems.find((item) => item.sourceId === responseId)?.includedText ?? "",
      /attached verifier/);
  } finally {
    f.close();
  }
});

test("handoff preview structurally includes current amendments and criteria", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "handoff-current-criteria");
    await f.hub.execute(member, {
      commandId: "amend-handoff-current-criteria", type: "task.amend",
      target: { kind: "task", id: taskId }, expected: { task: 1 },
      payload: { summary: "Require current verifier evidence.", supersedesCriterionIds: [],
        criteria: [{ key: "current-verifier", description: "Verify the current criterion.",
          requirement: "required", verification: "required" }] },
    });
    const repository = f.hub.registerProjectRepository(member, {
      projectId: "project-default", canonicalIdentity: "https://example.invalid/org/current-criteria.git",
    });

    // When
    const preview = f.hub.previewHandoff(member, {
      taskId, profileId: "profile-structured", repositoryId: repository.id,
      repositoryRevision: repository.revision, sourceBranch: "work/current-criteria", sourceCommit,
      requestedValidation: "Verify current criteria", selectedReferenceIds: [],
      selectedResponseIds: [], recipient: { kind: "new" },
    });

    // Then
    const input = PromptEnvelopeSchema.parse(JSON.parse(preview.prompt)).input;
    const criteria = z.array(z.object({ key: z.string() })).parse(input["criteria"]);
    const amendments = z.array(z.object({ summary: z.string() })).parse(input["amendments"]);
    assert.deepEqual(criteria.map((criterion) => criterion.key), ["current-verifier"]);
    assert.deepEqual(amendments.map((amendment) => amendment.summary), ["Require current verifier evidence."]);
  } finally {
    f.close();
  }
});
