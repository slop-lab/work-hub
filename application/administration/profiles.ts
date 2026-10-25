import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAdministrator, type Actor } from '../domain/authorization.ts';
import { conflict, invalid } from '../domain/errors.ts';
import { environmentSelectionSchema, jsonObjectSchema } from '../domain/schema-common.ts';
import type { Store } from '../persistence/database.ts';
import type { InstallationRepository } from './installations.ts';
import type { JsonValue } from '../contracts/index.ts';

const rowSchema = z.object({ id: z.string(), revision: z.number(), workspace_id: z.string(), label: z.string(), enabled: z.number(), runtime_installation_id: z.string(), configuration_json: z.string(), allowed_environment_modes_json: z.string(), default_environment_json: z.string(), required_capabilities_json: z.string(), allowed_effects_json: z.string() });
export const profileInput = z.strictObject({
  label: z.string().min(1).max(200), runtimeInstallationId: z.string().min(1),
  configuration: jsonObjectSchema.default({}),
  allowedEnvironmentModes: z.array(z.enum(['provision', 'existing', 'none'])).min(1),
  defaultEnvironment: environmentSelectionSchema,
  requiredCapabilities: z.array(z.string()).default([]),
  allowedEffects: z.array(z.enum(['task.read', 'work.write'])).default(['task.read']),
  enabled: z.boolean().default(true),
});
export const profilePatch = profileInput.partial();
type ProfileInput = z.infer<typeof profileInput>;

export class ProfileRepository {
  readonly store: Store;
  readonly installations: InstallationRepository;
  readonly supports: ((installationId: string, names: readonly string[]) => boolean) | undefined;
  constructor(store: Store, installations: InstallationRepository, supports?: (installationId: string, names: readonly string[]) => boolean) { this.store = store; this.installations = installations; this.supports = supports; }
  list(actor: Actor) {
    return this.store.database.prepare(`SELECT p.* FROM execution_profiles p WHERE workspace_id=? AND revision=(SELECT MAX(p2.revision) FROM execution_profiles p2 WHERE p2.id=p.id) ORDER BY label,id`).all(actor.workspaceId).map((raw) => {
      const row = rowSchema.parse(raw);
      return { id: row.id, revision: row.revision, ...profileInput.parse({ label: row.label, runtimeInstallationId: row.runtime_installation_id, configuration: JSON.parse(row.configuration_json), allowedEnvironmentModes: JSON.parse(row.allowed_environment_modes_json), defaultEnvironment: JSON.parse(row.default_environment_json), requiredCapabilities: JSON.parse(row.required_capabilities_json), allowedEffects: JSON.parse(row.allowed_effects_json), enabled: row.enabled === 1 }) };
    }).filter((item) => actor.role === 'administrator' || actor.profileIds.includes(item.id));
  }
  create(actor: Actor, input: ProfileInput) {
    requireAdministrator(actor);
    this.validate(actor, input);
    const id = randomUUID();
    this.insert(actor, { id, revision: 1, input });
    return { kind: 'profile', id, revision: 1 };
  }
  update(actor: Actor, change: { readonly id: string; readonly expectedRevision: number; readonly patch: z.infer<typeof profilePatch> }) {
    requireAdministrator(actor);
    const current = this.list(actor).find((item) => item.id === change.id);
    if (!current) throw invalid('not_found', 'Execution profile not found.');
    if (current.revision !== change.expectedRevision) throw conflict('revision_conflict', 'Profile changed; refresh before editing.');
    const { id: _id, revision: _revision, ...previous } = current;
    const input = profileInput.parse({ ...previous, ...change.patch });
    this.validate(actor, input);
    this.insert(actor, { id: change.id, revision: current.revision + 1, input });
    return { kind: 'profile', id: change.id, revision: current.revision + 1 };
  }
  private validate(actor: Actor, input: ProfileInput) {
    if (!input.allowedEnvironmentModes.includes(input.defaultEnvironment.mode)) throw invalid('environment_mode_denied', 'Default environment must be one of the allowed modes.');
    const installation = this.installations.list(actor).find((item) => item.id === input.runtimeInstallationId);
    if (!installation || installation.kind !== 'agent_runtime') throw invalid('runtime_installation_required', 'Select a registered runtime installation.');
    if (input.enabled && (!installation.available || !installation.enabled)) throw invalid(installation.reason, 'This connector is unavailable; the profile cannot be enabled.');
    if (input.enabled && input.requiredCapabilities.length && !this.supports?.(input.runtimeInstallationId, input.requiredCapabilities)) throw invalid('required_capability_unavailable', 'This profile requires an unsupported or unknown runtime capability.');
    const pending: JsonValue[] = [input.configuration];
    while (pending.length) {
      const value = pending.pop();
      if (value === null || typeof value !== 'object') continue;
      for (const [key, child] of Object.entries(value)) {
        if (/password|credential|token|api[_-]?key|secret/i.test(key)) throw invalid('literal_secret_forbidden', 'Runtime configuration cannot contain credential fields. Use externally configured secret references.');
        if (child !== null && typeof child === 'object') pending.push(child);
      }
    }
  }
  private insert(actor: Actor, record: { readonly id: string; readonly revision: number; readonly input: ProfileInput }) {
    const input = record.input;
    this.store.database.prepare('INSERT INTO execution_profiles VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(record.id, record.revision, actor.workspaceId, input.label, Number(input.enabled), input.runtimeInstallationId, JSON.stringify(input.configuration), JSON.stringify(input.allowedEnvironmentModes), JSON.stringify(input.defaultEnvironment), JSON.stringify(input.requiredCapabilities), JSON.stringify(input.allowedEffects), this.store.clock.now().toISOString());
  }
}
