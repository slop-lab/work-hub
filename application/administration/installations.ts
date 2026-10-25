import { z } from 'zod';
import { requireAdministrator, type Actor } from '../domain/authorization.ts';
import { conflict, invalid } from '../domain/errors.ts';
import type { Store } from '../persistence/database.ts';

const rowSchema = z.object({ id: z.string(), label: z.string(), revision: z.number(), kind: z.enum(['execution', 'agent_runtime']), contract_major: z.number(), enabled: z.number(), implementation: z.string() });
export const installationInput = z.strictObject({ id: z.string().min(1).max(256), label: z.string().min(1).max(200), kind: z.enum(['execution', 'agent_runtime']), contractMajor: z.number().int().positive(), implementation: z.string().min(1).max(100) });
export type InstallationInput = z.infer<typeof installationInput>;
const known = ['execution-sim', 'runtime-sim-structured', 'runtime-sim-limited'] as const;

export class InstallationRepository {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.database.exec(`CREATE TABLE IF NOT EXISTS connector_installations (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,label TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,contract_major INTEGER NOT NULL,enabled INTEGER NOT NULL,implementation TEXT NOT NULL);`);
    for (const id of known) store.database.prepare(`INSERT OR IGNORE INTO connector_installations VALUES(?,?,?,1,?,1,1,?)`).run(id, 'workspace-default', id, id === 'execution-sim' ? 'execution' : 'agent_runtime', 'simulator');
  }
  list(actor: Actor) {
    return this.store.database.prepare('SELECT * FROM connector_installations WHERE workspace_id=? ORDER BY id').all(actor.workspaceId).map((raw) => {
      const row = rowSchema.parse(raw);
      const available = row.contract_major === 1 && row.implementation === 'simulator' && known.some((id) => id === row.id);
      return { id: row.id, label: row.label, revision: row.revision, kind: row.kind, contractMajor: row.contract_major, enabled: row.enabled === 1, available, simulator: row.implementation === 'simulator', reason: available ? 'simulated_only' : row.contract_major !== 1 ? 'contract_major_mismatch' : 'connector_not_installed' };
    });
  }
  usable(actor: Actor, id: string): boolean { return this.list(actor).some((item) => item.id === id && item.available && item.enabled); }
  create(actor: Actor, input: InstallationInput) {
    requireAdministrator(actor);
    if (this.list(actor).some((item) => item.id === input.id)) throw conflict('installation_exists', 'Installation ID is already registered.');
    this.store.database.prepare('INSERT INTO connector_installations VALUES(?,?,?,1,?,?,1,?)').run(input.id, actor.workspaceId, input.label, input.kind, input.contractMajor, input.implementation);
    return { kind: 'installation', id: input.id, revision: 1 };
  }
  disable(actor: Actor, change: { readonly id: string; readonly expectedRevision: number }) {
    requireAdministrator(actor);
    const current = this.list(actor).find((item) => item.id === change.id);
    if (!current) throw invalid('not_found', 'Installation not found.');
    if (current.revision !== change.expectedRevision) throw conflict('revision_conflict', 'Installation changed.');
    this.store.database.prepare('UPDATE connector_installations SET enabled=0,revision=revision+1 WHERE id=? AND workspace_id=?').run(change.id, actor.workspaceId);
    return { kind: 'installation', id: change.id, revision: current.revision + 1 };
  }
}
