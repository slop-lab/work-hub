import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAdministrator, type Actor } from '../domain/authorization.ts';
import { conflict, invalid } from '../domain/errors.ts';
import type { Store } from '../persistence/database.ts';

const projectRow = z.object({ id: z.string(), revision: z.number(), name: z.string(), default_profile_id: z.string().nullable(), archived_at: z.string().nullable() });
export const projectInput = z.strictObject({ name: z.string().trim().min(1).max(200), defaultProfileId: z.string().optional() });
export type ProjectInput = z.infer<typeof projectInput>;

export class ProjectRepository {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }
  list(actor: Actor) {
    return this.store.database.prepare('SELECT * FROM projects WHERE workspace_id=? ORDER BY name,id').all(actor.workspaceId).map((raw) => projectRow.parse(raw)).filter((row) => actor.role === 'administrator' || actor.projectIds.includes(row.id)).map((row) => ({ id: row.id, revision: row.revision, name: row.name, ...(row.default_profile_id ? { defaultProfileId: row.default_profile_id } : {}), ...(row.archived_at ? { archivedAt: row.archived_at } : {}) }));
  }
  create(actor: Actor, input: ProjectInput) {
    requireAdministrator(actor);
    this.checkProfile(actor, input.defaultProfileId);
    const id = randomUUID();
    const now = this.store.clock.now().toISOString();
    this.store.database.prepare('INSERT INTO projects VALUES(?,?,1,?,?,NULL,?,?)').run(id, actor.workspaceId, input.name, input.defaultProfileId ?? null, now, now);
    return { kind: 'project', id, revision: 1 };
  }
  update(actor: Actor, change: { readonly id: string; readonly expectedRevision: number; readonly input: ProjectInput }) {
    requireAdministrator(actor);
    const current = this.list(actor).find((item) => item.id === change.id);
    if (!current) throw invalid('not_found', 'Project not found.');
    if (current.revision !== change.expectedRevision) throw conflict('revision_conflict', 'Project changed; refresh before editing.');
    this.checkProfile(actor, change.input.defaultProfileId);
    this.store.database.prepare('UPDATE projects SET revision=revision+1,name=?,default_profile_id=?,updated_at=? WHERE id=? AND workspace_id=?').run(change.input.name, change.input.defaultProfileId ?? null, this.store.clock.now().toISOString(), change.id, actor.workspaceId);
    return { kind: 'project', id: change.id, revision: current.revision + 1 };
  }
  private checkProfile(actor: Actor, profileId: string | undefined) {
    if (profileId && !this.store.database.prepare('SELECT id FROM (SELECT id,enabled FROM execution_profiles WHERE id=? AND workspace_id=? ORDER BY revision DESC LIMIT 1) WHERE enabled=1').get(profileId, actor.workspaceId)) throw invalid('profile_unavailable', 'Project default profile is unavailable.');
  }
}
