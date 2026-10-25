import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../domain/authorization.ts';
import { requireAdministrator } from '../domain/authorization.ts';
import { conflict, invalid } from '../domain/errors.ts';
import type { Store } from '../persistence/database.ts';

const grants = z.strictObject({ projectIds: z.array(z.string()), profileIds: z.array(z.string()), bindingIds: z.array(z.string()) });
const userRow = z.object({ id: z.string(), workspace_id: z.string(), display_name: z.string(), role: z.enum(['administrator', 'member', 'automation']), enabled: z.number(), revision: z.number(), grants_json: z.string() });
export const userInput = z.strictObject({
  displayName: z.string().trim().min(1).max(200),
  role: z.enum(['administrator', 'member', 'automation']),
  projectIds: z.array(z.string()), profileIds: z.array(z.string()), bindingIds: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});
export type UserInput = z.infer<typeof userInput>;

export class UserRepository {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    const db = store.database;
    db.exec(`CREATE TABLE IF NOT EXISTS user_grants (user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, grants_json TEXT NOT NULL);`);
    const now = store.clock.now().toISOString();
    db.prepare(`INSERT OR IGNORE INTO users VALUES(?,?,?,?,?,?,?,?)`).run('user-admin', 'workspace-default', 'local:user-admin', 'Workspace administrator', 'administrator', 1, now, now);
    db.prepare(`INSERT OR IGNORE INTO user_grants VALUES(?,1,?)`).run('user-admin', JSON.stringify({ projectIds: ['project-default'], profileIds: ['profile-structured', 'profile-limited'], bindingIds: [] }));
  }
  actorForUser(userId: string): Actor | undefined {
    const raw = this.store.database.prepare(`SELECT u.*,g.revision,g.grants_json FROM users u JOIN user_grants g ON g.user_id=u.id WHERE u.id=? AND u.enabled=1`).get(userId);
    if (!raw) return undefined;
    const row = userRow.parse(raw);
    return { id: row.id, workspaceId: row.workspace_id, role: row.role, ...grants.parse(JSON.parse(row.grants_json)) };
  }
  list(actor: Actor) {
    return this.store.database.prepare(`SELECT u.*,g.revision,g.grants_json FROM users u JOIN user_grants g ON g.user_id=u.id WHERE u.workspace_id=? ORDER BY u.display_name,u.id`).all(actor.workspaceId).map((raw) => {
      const row = userRow.parse(raw);
      return { id: row.id, displayName: row.display_name, role: row.role, enabled: row.enabled === 1, revision: row.revision, ...grants.parse(JSON.parse(row.grants_json)) };
    });
  }
  create(actor: Actor, input: UserInput) {
    requireAdministrator(actor);
    this.checkProjects(actor, input.projectIds);
    const id = randomUUID();
    const now = this.store.clock.now().toISOString();
    this.store.database.prepare(`INSERT INTO users VALUES(?,?,?,?,?,?,?,?)`).run(id, actor.workspaceId, `local:${id}`, input.displayName, input.role, Number(input.enabled), now, now);
    this.store.database.prepare(`INSERT INTO user_grants VALUES(?,1,?)`).run(id, JSON.stringify({ projectIds: input.projectIds, profileIds: input.profileIds, bindingIds: input.bindingIds }));
    return { kind: 'user', id, revision: 1 };
  }
  update(actor: Actor, change: { readonly id: string; readonly expectedRevision: number; readonly input: UserInput }) {
    requireAdministrator(actor);
    const current = this.list(actor).find((item) => item.id === change.id);
    if (!current) throw invalid('not_found', 'User not found.');
    if (current.revision !== change.expectedRevision) throw conflict('revision_conflict', 'User permissions changed; refresh before editing.');
    if (current.id === actor.id && (!change.input.enabled || change.input.role !== 'administrator')) throw conflict('self_lockout', 'An administrator cannot disable or demote their own account.');
    this.checkProjects(actor, change.input.projectIds);
    this.store.database.prepare(`UPDATE users SET display_name=?,role=?,enabled=?,updated_at=? WHERE id=? AND workspace_id=?`).run(change.input.displayName, change.input.role, Number(change.input.enabled), this.store.clock.now().toISOString(), change.id, actor.workspaceId);
    this.store.database.prepare(`UPDATE user_grants SET revision=revision+1,grants_json=? WHERE user_id=?`).run(JSON.stringify({ projectIds: change.input.projectIds, profileIds: change.input.profileIds, bindingIds: change.input.bindingIds }), change.id);
    return { kind: 'user', id: change.id, revision: current.revision + 1 };
  }
  private checkProjects(actor: Actor, projectIds: readonly string[]) {
    for (const id of projectIds) {
      if (!this.store.database.prepare('SELECT id FROM projects WHERE id=? AND workspace_id=? AND archived_at IS NULL').get(id, actor.workspaceId)) throw invalid('project_unavailable', 'A permission refers to an unavailable project.');
    }
  }
}
