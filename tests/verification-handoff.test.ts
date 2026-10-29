import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthStore } from "../application/api/auth-store.ts";
import { createApplication } from "../application/api/app.ts";
import { renderVerificationPrompt } from "../application/domain/handoff-prompt.ts";
import { RecipientIntegrationPromptSchema } from "../application/contracts/handoff.ts";
import { admin, createTask, delegateNone, finishAttempt, fixture, member } from "./acceptance-fixture.ts";

const sourceCommit = "a".repeat(40);
const contextDigest = `sha256:${"b".repeat(64)}`;

test("canonical prompt renderer reassembles the same preview digest", () => {
  // Given
  const input = {
    task: { id: "task-1", revision: 7, title: "Verify release", description: "Run native checks." },
    repository: { id: "repo-1", projectId: "project-default", canonicalIdentity: "https://example.invalid/org/repo.git", revision: 3 },
    verification: { repositoryId: "repo-1", repositoryRevision: 3, sourceBranch: "work/verify", sourceCommit, requestedValidation: "Ubuntu native verification", contextDigest },
  } as const;

  // When
  const first = renderVerificationPrompt(input);
  const second = renderVerificationPrompt(input);

  // Then
  assert.equal(second.promptDigest, first.promptDigest);
  assert.equal(second.prompt, first.prompt);
  const rendered = JSON.parse(first.prompt) as { readonly recipientIntegration: unknown };
  assert.deepEqual(RecipientIntegrationPromptSchema.parse(rendered.recipientIntegration), {
    assignmentTool: "workhub_assignment", acknowledgmentTool: "workhub_ack",
    resultTool: "workhub_result", assignmentReadRequired: true,
    deliveryAcknowledgmentRequired: true, humanAcceptanceSeparate: true,
  });
});

test("preview delegation binds exact repository source context and target identity", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "handoff-preview");
    const repository = f.hub.registerProjectRepository(member, {
      projectId: "project-default",
      canonicalIdentity: "https://example.invalid/org/repo.git",
    });
    const preview = f.hub.previewHandoff(member, {
      taskId,
      profileId: "profile-structured",
      repositoryId: repository.id,
      repositoryRevision: repository.revision,
      sourceBranch: "work/verify",
      sourceCommit,
      requestedValidation: "Ubuntu native verification",
      contextDigest,
      recipient: { kind: "new" },
    });
    assert.equal(preview.target["kind"], "new");
    assert.equal(preview.target["runtimeInstallationId"], "runtime-sim-structured");

    // When
    const delegated = await f.hub.execute(member, {
      commandId: "delegate-bound-handoff",
      type: "attempt.delegate",
      target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision, profile: 1 },
      payload: {
        profileId: "profile-structured",
        environment: { mode: "none" },
        selectedReferenceIds: [],
        selectedResponseIds: [],
        authorizedEffectKinds: [],
        handoff: {
          previewDigest: preview.previewDigest,
          verification: preview.verification,
          recipient: { kind: "new" },
        },
      },
    });

    // Then
    assert.equal(delegated.status, "accepted");
    const attemptId = delegated.objectRefs[0]?.id;
    assert.ok(attemptId);
    const detail = f.hub.getHandoff(member, attemptId);
    assert.equal(detail.preview.previewDigest, preview.previewDigest);
    assert.equal(detail.attempt.inputSnapshot["promptDigest"], preview.promptDigest);
    assert.deepEqual(detail.attempt.inputSnapshot["verification"], preview.verification);
    assert.equal(detail.delivery["status"], "pending");
  } finally {
    f.close();
  }
});

test("stale source context and target mismatches reject preview delegation", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "handoff-stale");
    const repository = f.hub.registerProjectRepository(member, {
      projectId: "project-default",
      canonicalIdentity: "ssh://git@example.invalid/org/repo.git",
    });
    const preview = f.hub.previewHandoff(member, {
      taskId,
      profileId: "profile-structured",
      repositoryId: repository.id,
      repositoryRevision: repository.revision,
      sourceBranch: "work/verify",
      sourceCommit,
      requestedValidation: "Ubuntu native verification",
      contextDigest,
      recipient: { kind: "new" },
    });

    // When
    const receipt = await f.hub.execute(member, {
      commandId: "delegate-stale-handoff",
      type: "attempt.delegate",
      target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision, profile: 1 },
      payload: {
        profileId: "profile-structured",
        environment: { mode: "none" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
        handoff: {
          previewDigest: preview.previewDigest,
          verification: { ...preview.verification, sourceCommit: "c".repeat(40) },
          recipient: { kind: "new" },
        },
      },
    });

    // Then
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.error?.code, "handoff_preview_stale");
    assert.equal(f.hub.listHandoffs(member, taskId).length, 0);
  } finally {
    f.close();
  }
});

test("attached recipient delegates into the exact idle existing session without opening another", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "handoff-attached");
    const predecessor = await delegateNone(f.hub, taskId, "handoff-attached-predecessor");
    await finishAttempt(f.hub, predecessor);
    const session = f.hub.getSession(member, predecessor.sessionId).session;
    const repository = f.hub.registerProjectRepository(member, {
      projectId: "project-default", canonicalIdentity: "repo:attached",
    });
    const recipient = { kind: "attached", sessionId: session.id, sessionRevision: session.revision,
      bindingGeneration: session.bindingGeneration, profileId: "profile-structured", profileRevision: 1 } as const;
    const preview = f.hub.previewHandoff(member, { taskId, profileId: "profile-structured",
      repositoryId: repository.id, repositoryRevision: repository.revision, sourceBranch: "work/attached",
      sourceCommit, requestedValidation: "Attached verifier", contextDigest, recipient });

    // When
    const delegated = await f.hub.execute(member, { commandId: "delegate-attached-handoff",
      type: "attempt.delegate", target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision, profile: 1 },
      payload: { profileId: "profile-structured", environment: { mode: "none" }, selectedReferenceIds: [],
        selectedResponseIds: [], authorizedEffectKinds: [], handoff: { previewDigest: preview.previewDigest,
          verification: preview.verification, recipient } } });

    // Then
    assert.equal(delegated.status, "accepted");
    const attemptId = delegated.objectRefs[0]?.id;
    assert.ok(attemptId);
    const attempt = f.hub.getHandoff(member, attemptId).attempt;
    assert.equal(attempt.sessionId, session.id);
    assert.equal(f.hub.snapshot(member).sessions.length, 1);
  } finally {
    f.close();
  }
});

test("bound result outcome is idempotent while human completion remains separate", async () => {
  // Given
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, "handoff-result");
    const repository = f.hub.registerProjectRepository(member, { projectId: "project-default", canonicalIdentity: "repo:result" });
    const preview = f.hub.previewHandoff(member, { taskId, profileId: "profile-structured", repositoryId: repository.id,
      repositoryRevision: repository.revision, sourceBranch: "work/verify", sourceCommit,
      requestedValidation: "Native suite", contextDigest, recipient: { kind: "new" } });
    const delegated = await f.hub.execute(member, { commandId: "delegate-result", type: "attempt.delegate", target: { kind: "task", id: taskId },
      expected: { task: f.hub.getTask(member, taskId).revision, profile: 1 }, payload: { profileId: "profile-structured", environment: { mode: "none" },
        selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [], handoff: { previewDigest: preview.previewDigest, verification: preview.verification, recipient: { kind: "new" } } } });
    const attemptId = delegated.objectRefs[0]?.id;
    assert.ok(attemptId);
    const inputDigest = String(f.hub.getHandoff(member, attemptId).attempt.inputSnapshot["digest"]);
    const command = { commandId: "result-bound", type: "result.submit", target: { kind: "attempt", id: attemptId }, payload: {
      submissionKey: "native-suite:ubuntu", outcome: "partial", inputDigest,
      actualCommit: sourceCommit, actualContextDigest: contextDigest,
      summary: "Most checks passed.", limitations: ["H264 unavailable"], referenceIds: [], evidence: [{ origin: "agent_claim", detail: "Native suite report" }],
      artifacts: [{ repositoryId: repository.id, sourceCommit, path: "reports/native.json",
        digest: `sha256:${"d".repeat(64)}` }],
    } } as const;

    // When
    const first = await f.hub.execute(member, command);
    const replay = await f.hub.execute(member, { ...command, commandId: "result-bound-replay" });

    // Then
    assert.equal(first.status, "confirmed");
    assert.equal(replay.objectRefs[0]?.id, first.objectRefs[0]?.id);
    const result = f.hub.snapshot(member).results[0];
    assert.equal(result?.outcome, "partial");
    assert.equal(result?.artifacts[0]?.["path"], "reports/native.json");
    assert.equal(f.hub.getTask(member, taskId).status, "active");
  } finally {
    f.close();
  }
});

test("recipient exchange accepts only configured integration credentials for the exact current native session", async () => {
  // Given
  const f = fixture();
  const auth = new AuthStore(":memory:");
  try {
    const taskId = await createTask(f.hub, "recipient-exchange", admin);
    const repository = f.hub.registerProjectRepository(admin, {
      projectId: "project-default", canonicalIdentity: "repo:exchange",
    });
    const preview = f.hub.previewHandoff(admin, { taskId, profileId: "profile-structured",
      repositoryId: repository.id, repositoryRevision: repository.revision,
      sourceBranch: "work/exchange", sourceCommit, requestedValidation: "Exchange verification",
      contextDigest, recipient: { kind: "new" } });
    const delegated = await f.hub.execute(admin, { commandId: "exchange-delegate", type: "attempt.delegate", target: { kind: "task", id: taskId },
      expected: { task: 1, profile: 1 }, payload: { profileId: "profile-structured", environment: { mode: "none" }, selectedReferenceIds: [], selectedResponseIds: [],
        handoff: { previewDigest: preview.previewDigest, verification: preview.verification, recipient: { kind: "new" } } } });
    await f.hub.drain();
    const attemptId = delegated.objectRefs[0]?.id;
    assert.ok(attemptId);
    const session = f.hub.getSession(admin, f.hub.snapshot(admin).attempts.find((item) => item.id === attemptId)?.sessionId ?? "").session;
    assert.ok(session.nativeIdentityKey);
    const nativeSession = JSON.parse(session.nativeIdentityKey) as { readonly incarnation?: string };
    const incarnation = nativeSession.incarnation ?? "incarnation-1";
    const targetWorkspaceId = "11111111-1111-4111-8111-111111111111";
    const integration = auth.configureRecipientIntegration({ installationId: session.runtimeInstallationId,
      hostId: "host-1", workHubWorkspaceId: admin.workspaceId, targetWorkspaceId,
      incarnation, authorization: "Bearer integration-secret" });
    const app = createApplication({ hub: f.hub, auth, origin: "http://localhost:3000", secureCookies: false });
    const userToken = auth.bootstrap("user-admin");
    const nativeSessionId = (JSON.parse(session.nativeIdentityKey) as { readonly id: string }).id;
    const body = { nativeSessionId };

    // When
    const denied = await app.request("/api/v1/recipient/exchange", { method: "POST", headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const exchanged = await app.request("/api/v1/recipient/exchange", { method: "POST", headers: { Authorization: integration, "Content-Type": "application/json" }, body: JSON.stringify(body) });

    // Then
    assert.equal(denied.status, 403);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const payload = await exchanged.json() as { readonly token: string; readonly expiresAt: string;
      readonly assignment: { readonly attemptId: string; readonly workHubWorkspaceId: string;
        readonly targetWorkspaceId: string } };
    assert.equal(payload.assignment.attemptId, attemptId);
    assert.equal(payload.assignment.workHubWorkspaceId, admin.workspaceId);
    assert.equal(payload.assignment.targetWorkspaceId, targetWorkspaceId);
    assert.ok(auth.authenticate(payload.token)?.kind === "bridge");
    const bridgeHeaders = { Authorization: `Bearer ${payload.token}`, "Content-Type": "application/json" };
    const assignment = await app.request("/api/v1/bridge/assignment", { headers: bridgeHeaders });
    assert.equal(assignment.status, 200);
    const deliveryDigest = (await assignment.json() as { readonly deliveryDigest: string }).deliveryDigest;
    const acknowledged = await app.request("/api/v1/bridge/attempt-delivery/ack", { method: "POST",
      headers: bridgeHeaders, body: JSON.stringify({ deliveryDigest }) });
    assert.equal(acknowledged.status, 200);
    assert.equal(f.hub.getHandoff(admin, attemptId).delivery["status"], "acknowledged");
    const wrongNative = await app.request("/api/v1/recipient/exchange", { method: "POST",
      headers: { Authorization: integration, "Content-Type": "application/json" },
      body: JSON.stringify({ nativeSessionId: "ses_other" }) });
    assert.notEqual(wrongNative.status, 200);
    auth.revokeRecipientIntegration(integration);
    const revoked = await app.request("/api/v1/recipient/exchange", { method: "POST",
      headers: { Authorization: integration, "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    assert.equal(revoked.status, 403);
  } finally {
    auth.close();
    f.close();
  }
});

test("repository discovery API returns canonical project repositories without credentials", async () => {
  // Given
  const f = fixture();
  const auth = new AuthStore(":memory:");
  try {
    const token = auth.bootstrap("user-admin");
    const app = createApplication({ hub: f.hub, auth, origin: "http://localhost:3000", secureCookies: false });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    await app.request("/api/v1/projects/project-default/repositories", { method: "POST", headers,
      body: JSON.stringify({ canonicalIdentity: "https://example.invalid/one.git" }) });
    await app.request("/api/v1/projects/project-default/repositories", { method: "POST", headers,
      body: JSON.stringify({ canonicalIdentity: "https://example.invalid/two.git" }) });

    // When
    const response = await app.request("/api/v1/projects/project-default/repositories", { headers });

    // Then
    assert.equal(response.status, 200);
    const items = (await response.json() as { readonly items: readonly { readonly canonicalIdentity: string }[] }).items;
    assert.deepEqual(items.map((item) => item.canonicalIdentity), [
      "https://example.invalid/one.git", "https://example.invalid/two.git",
    ]);
    assert.equal(JSON.stringify(items).includes("authorization"), false);
  } finally {
    auth.close();
    f.close();
  }
});
