import type { DatabaseSync } from 'node:sqlite';

export function hasOtherActiveIdentityBinding(database: DatabaseSync, input: {
  readonly workspaceId: string; readonly bindingId: string; readonly nativeId: string; readonly incarnation?: string;
}): boolean {
  return database.prepare(`SELECT 1 FROM environment_bindings WHERE workspace_id = ?
    AND id <> ? AND state NOT IN ('detached','released','failed')
    AND json_extract(identity_json, '$.native.id') = ?
    AND COALESCE(json_extract(identity_json, '$.native.incarnation'), '') = ? LIMIT 1`)
    .get(input.workspaceId, input.bindingId, input.nativeId, input.incarnation ?? '') !== undefined;
}
