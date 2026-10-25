import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store } from "../application/persistence/database.ts";
import { StateRepository } from "../application/persistence/state-repository.ts";

test("attachment persistence preserves prior allocation lifecycle authority and rejects replacement", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "work-hub-attachment-grant-"));
  const store = new Store(join(root, "hub.sqlite"));
  try {
    const now = store.clock.now().toISOString();
    const originalGrant = { id: "grant-original", releasePolicyRef: "retain" };
    store.database.prepare(`INSERT INTO environment_bindings
      (id, workspace_id, session_id, source_kind, source_id, identity_json,
       lifecycle_grant_json, work_area_keys_json, access_mode, generation, state,
       created_at, updated_at) VALUES (?, ?, ?, 'allocation', ?, ?, ?, '[]', 'read', 1,
       'waiting', ?, ?)`).run("binding", "workspace", "session", "allocation",
        JSON.stringify({ native: { id: "allocation" } }), JSON.stringify(originalGrant), now, now);
    const state = new StateRepository(store.database, store.clock);

    // When
    const omittedCompatible = state.saveEnvironmentAttachment({ workspaceId: "workspace",
      bindingId: "binding", attachment: { id: "attachment-1" }, identity: {}, useGrant: {} });
    const replacementCompatible = state.saveEnvironmentAttachment({ workspaceId: "workspace",
      bindingId: "binding", attachment: { id: "attachment-2" }, identity: {}, useGrant: {},
      lifecycleGrant: { id: "grant-replacement", releasePolicyRef: "delete" } });

    // Then
    assert.equal(omittedCompatible, true);
    assert.equal(replacementCompatible, false);
    const row = store.database.prepare(`SELECT lifecycle_grant_json AS lifecycleGrantJson
      FROM environment_bindings WHERE id = 'binding'`).get();
    assert.ok(typeof row === "object" && row !== null);
    assert.deepEqual(JSON.parse(String(Reflect.get(row, "lifecycleGrantJson"))), originalGrant);
  } finally {
    store.close();
    rmSync(root, { recursive: true });
  }
});
