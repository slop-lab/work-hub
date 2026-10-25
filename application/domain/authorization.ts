import { forbidden } from "./errors.ts";

export type ActorRole = "administrator" | "member" | "runtime" | "automation";

export type Actor = {
  readonly id: string;
  readonly workspaceId: string;
  readonly role: ActorRole;
  readonly projectIds: readonly string[];
  readonly profileIds: readonly string[];
  readonly bindingIds: readonly string[];
  readonly sessionId?: string;
  readonly attemptId?: string;
  readonly bindingGeneration?: number;
  readonly allowedCommandTypes?: readonly string[];
};

export function requireAdministrator(actor: Actor): void {
  if (actor.role !== "administrator") {
    throw forbidden("Administrator authority is required.");
  }
}

export function requireProject(actor: Actor, projectId: string): void {
  if (actor.role !== "administrator" && !actor.projectIds.includes(projectId)) {
    throw forbidden("The actor cannot access this project.");
  }
}

export function requireProfile(actor: Actor, profileId: string): void {
  if (actor.role !== "administrator" && !actor.profileIds.includes(profileId)) {
    throw forbidden("The actor cannot use this execution profile.");
  }
}

export function requireBinding(actor: Actor, bindingId: string): void {
  if (actor.role !== "administrator" && !actor.bindingIds.includes(bindingId)) {
    throw forbidden("The actor has no authority over this binding.");
  }
}

export function requireCommandScope(actor: Actor, commandType: string): void {
  if ((actor.role === 'runtime' || actor.role === 'automation') && actor.allowedCommandTypes === undefined) throw forbidden('Service principals require an explicit command allowlist.');
  if (actor.role === 'runtime' && !['request.create', 'request.respond', 'result.submit', 'attempt.report', 'bridge.response.ack'].includes(commandType)) throw forbidden('Runtime principals cannot own task decisions or execution orchestration.');
  if (
    actor.allowedCommandTypes !== undefined &&
    !actor.allowedCommandTypes.includes(commandType)
  ) {
    throw forbidden("The service principal is not scoped for this command.");
  }
}
