import { z } from 'zod';
import type { Actor } from '../domain/authorization.ts';
import { envelope } from '../domain/schema-common.ts';
import { invalid } from '../domain/errors.ts';
import type { Store } from '../persistence/database.ts';
import { UserRepository, userInput } from './users.ts';
import { ProjectRepository, projectInput } from './projects.ts';
import { InstallationRepository, installationInput } from './installations.ts';
import { ProfileRepository, profileInput, profilePatch } from './profiles.ts';
import { ViewStateRepository } from './views.ts';
import { OutputRetention, retentionLimits } from '../artifacts/retention.ts';
import { requireAdministrator } from '../domain/authorization.ts';

export const adminCommandSchemas = [
  envelope('user.create', userInput),
  envelope('user.update', userInput.partial().extend({ expectedRevision: z.number().int().positive() })),
  envelope('user.disable', z.strictObject({ expectedRevision: z.number().int().positive() })),
  envelope('project.create', projectInput),
  envelope('project.update', projectInput.extend({ expectedRevision: z.number().int().positive() })),
  envelope('installation.create', installationInput),
  envelope('installation.disable', z.strictObject({ expectedRevision: z.number().int().positive() })),
  envelope('profile.create', profileInput),
  envelope('profile.update', profilePatch),
  envelope('profile.disable', z.strictObject({})),
  envelope('attention.markRead', z.strictObject({ attentionKey: z.string().min(1).max(512) })),
  envelope('attention.dismiss', z.strictObject({ attentionKey: z.string().min(1).max(512) })),
  envelope('retention.apply', retentionLimits),
] as const;
export const adminCommandSchema = z.discriminatedUnion('type', adminCommandSchemas);
export type AdminCommand = z.infer<typeof adminCommandSchema>;

export class Administration {
  readonly users: UserRepository;
  readonly projects: ProjectRepository;
  readonly installations: InstallationRepository;
  readonly profiles: ProfileRepository;
  readonly views: ViewStateRepository;
  constructor(store: Store, options: { readonly runtimeSupports?: (installationId: string, names: readonly string[]) => boolean; readonly connectorAvailable?: (kind: 'execution' | 'agent_runtime', id: string) => boolean } = {}) {
    this.users = new UserRepository(store);
    this.projects = new ProjectRepository(store);
    this.installations = new InstallationRepository(store, options.connectorAvailable);
    this.profiles = new ProfileRepository(store, this.installations, options.runtimeSupports);
    this.views = new ViewStateRepository(store);
  }
  apply(actor: Actor, command: AdminCommand) {
    const targetId = command.target?.id;
    switch (command.type) {
      case 'user.create': return this.users.create(actor, command.payload);
      case 'project.create': return this.projects.create(actor, command.payload);
      case 'installation.create': return this.installations.create(actor, command.payload);
      case 'profile.create': return this.profiles.create(actor, command.payload);
      case 'attention.markRead': return this.views.mark(actor, { attentionKey: command.payload.attentionKey, action: 'read' });
      case 'attention.dismiss': return this.views.mark(actor, { attentionKey: command.payload.attentionKey, action: 'dismiss' });
      case 'retention.apply': {
        requireAdministrator(actor);
        new OutputRetention(this.users.store.database, this.users.store.clock, command.payload).applyWorkspace(actor);
        return { kind: 'workspace', id: actor.workspaceId, revision: 1 };
      }
      case 'profile.update':
      case 'profile.disable': {
        if (!targetId || command.target?.kind !== 'profile') throw invalid('invalid_target', 'Select a profile.');
        const expectedRevision = command.expected?.profile;
        if (expectedRevision === undefined) throw invalid('expected_revision_required', 'The current profile revision is required.');
        return this.profiles.update(actor, { id: targetId, expectedRevision, patch: command.type === 'profile.disable' ? { enabled: false } : command.payload });
      }
      case 'user.update': {
        if (!targetId || command.target?.kind !== 'user') throw invalid('invalid_target', 'Select a user.');
        const user = this.users.list(actor).find((item) => item.id === targetId);
        if (!user) throw invalid('not_found', 'User not found.');
        const { expectedRevision, ...patch } = command.payload;
        const { id: _id, revision: _revision, ...previous } = user;
        return this.users.update(actor, { id: targetId, expectedRevision, input: userInput.parse({ ...previous, ...patch }) });
      }
      case 'user.disable': {
        if (!targetId || command.target?.kind !== 'user') throw invalid('invalid_target', 'Select a user.');
        const user = this.users.list(actor).find((item) => item.id === targetId);
        if (!user) throw invalid('not_found', 'User not found.');
        return this.users.update(actor, { id: targetId, expectedRevision: command.payload.expectedRevision, input: { ...user, enabled: false } });
      }
      case 'project.update':
        if (!targetId || command.target?.kind !== 'project') throw invalid('invalid_target', 'Select a project.');
        return this.projects.update(actor, { id: targetId, expectedRevision: command.payload.expectedRevision, input: command.payload });
      case 'installation.disable':
        if (!targetId || command.target?.kind !== 'installation') throw invalid('invalid_target', 'Select an installation.');
        return this.installations.disable(actor, { id: targetId, expectedRevision: command.payload.expectedRevision });
      default: return assertNever(command);
    }
  }
}
function assertNever(value: never): never { throw invalid('unsupported_command', `Unsupported command: ${String(value)}`); }
