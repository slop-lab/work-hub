import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Hub } from "../../application/orchestration/hub.ts";
import { claimPreviewDirectory } from "../../scripts/ui-preview-ownership.ts";
import { seedPreview } from "../../scripts/ui-preview-seed.ts";

test("seedPreview creates representative real Hub and simulator states without exposing the token", async () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "work-hub-preview-seed-"));
  const repositoryRoot = join(root, "repository");
  mkdirSync(repositoryRoot);
  const paths = claimPreviewDirectory({ directory: join(root, "preview"), repositoryRoot });

  // When
  const manifest = await seedPreview(paths);

  // Then
  assert.equal(Object.keys(manifest.scenarios).length, 7);
  assert.equal(statSync(paths.tokenPath).mode & 0o777, 0o600);
  const token = readFileSync(paths.tokenPath, "utf8").trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(manifest).includes(token), false);

  const hub = new Hub(paths.hubPath);
  try {
    const administrator = hub.actorForUser("user-admin");
    assert.ok(administrator);
    const snapshot = hub.snapshot(administrator);
    assert.equal(snapshot.attempts.some((attempt) => attempt.phase === "running"), true);
    assert.equal(snapshot.requests.some((request) => request.status === "open" && request.blocking === "runtime_action"), true);
    assert.equal(snapshot.attempts.some((attempt) => attempt.outcome === "ended_without_result"), true);
    assert.equal(snapshot.attempts.some((attempt) => attempt.outcome === "failed"), true);
    assert.equal(snapshot.attempts.some((attempt) => attempt.outcome === "canceled"), true);
    assert.equal(snapshot.results.length, 1);
    assert.equal(snapshot.dashboard.deliveryProblems.length, 1);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await hub.reconcile();
      await hub.drain();
    }
    assert.equal(hub.getDashboard(administrator).deliveryProblems.length, 1);
    hub.simulator?.controls.setDeliveryLookupAvailable(manifest.scenarios.answeredDeliveryUnknown.sessionId, true);
    const operationId = hub.simulator?.calls.list().find((call) => call.operationKind === "runtime.deliverResponse")?.operationId;
    assert.ok(operationId);
    await hub.execute(administrator, { commandId: "preview-test-reconcile", type: "operation.reconcile",
      target: { kind: "operation", id: operationId }, payload: {} });
    await hub.drain();
    assert.equal(hub.getDashboard(administrator).deliveryProblems.length, 0);
    assert.equal(snapshot.output?.some((item) => String(item["itemJson"]).includes('"kind":"gap"')), true);
  } finally {
    hub.close();
  }
});
