import type { Actor } from '../domain/authorization.ts';
import { requireAdministrator } from '../domain/authorization.ts';
import { commandTargetId } from '../domain/commands.ts';
import { conflict } from '../domain/errors.ts';
import { digest } from '../persistence/codec.ts';
import type { EnvironmentRepository } from '../persistence/environment-repository.ts';
import type { OperationRepository } from '../persistence/operation-repository.ts';
import type { StateRepository } from '../persistence/state-repository.ts';
import { requireRevision } from './guards.ts';
import type { CommandOf, CommandResult } from './types.ts';

export class EnvironmentRegistryHandler {
  readonly input: { readonly environments: EnvironmentRepository; readonly operations: OperationRepository; readonly state: StateRepository; readonly requireInstallation: (workspaceId: string, kind: 'execution' | 'agent_runtime', id: string) => void };
  constructor(input: EnvironmentRegistryHandler['input']) { this.input = input; }
  register(actor: Actor, command: CommandOf<'environment.register'>): CommandResult {
    requireAdministrator(actor);
    this.input.requireInstallation(actor.workspaceId, 'execution', command.payload.executionInstallationId);
    const registration = this.input.environments.createRegistration({ workspaceId: actor.workspaceId, ...command.payload });
    return { status: 'confirmed', confirmedEffect: 'environment.registration.persisted', objectRefs: [{ kind: 'environment_registration', id: registration.id, revision: 1 }], operationIds: [] };
  }
  verify(actor: Actor, command: CommandOf<'environment.verify'>): CommandResult {
    requireAdministrator(actor);
    const id = commandTargetId(command, 'environment_registration');
    const registration = this.input.environments.getRegistration(actor.workspaceId, id);
    this.input.requireInstallation(actor.workspaceId, 'execution', registration.executionInstallationId);
    requireRevision(registration.revision, command.expected?.registration, 'Registration');
    const payload = { registrationId: id, expectedRevision: registration.revision };
    const operationId = this.input.operations.addOutbox({ workspaceId: actor.workspaceId, commandId: command.commandId, workType: 'execution.probeExisting', connectorKind: 'execution', installationId: registration.executionInstallationId, stage: 'verify_registration', targetId: id, payload, inputDigest: digest(payload) });
    return { status: 'accepted', confirmedEffect: 'environment.verification.requested', objectRefs: [{ kind: 'environment_registration', id }], operationIds: [operationId] };
  }
  retire(actor: Actor, command: CommandOf<'environment.retire'>): CommandResult {
    requireAdministrator(actor);
    const id = commandTargetId(command, 'environment_registration');
    const registration = this.input.environments.getRegistration(actor.workspaceId, id);
    requireRevision(registration.revision, command.expected?.registration, 'Registration');
    if (this.input.state.hasUnresolvedBindingForRegistration(actor.workspaceId, id)) throw conflict('registration_in_use', 'Unresolved bindings prevent registration retirement.');
    const retired = this.input.environments.retire(actor.workspaceId, id);
    return { status: 'confirmed', confirmedEffect: 'environment.registration.retired', objectRefs: [{ kind: 'environment_registration', id, revision: retired.revision }], operationIds: [] };
  }
}
