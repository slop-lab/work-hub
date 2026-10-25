import type { Actor } from "../domain/authorization.ts";
import { requireProject } from "../domain/authorization.ts";
import { conflict, forbidden, invalid } from "../domain/errors.ts";
import type { RequestView, SessionView, TaskView } from "../domain/model.ts";

export function requireRevision(actual: number, expected: number | undefined, kind: string): void {
  if (expected === undefined) {
    throw invalid("expected_revision_required", `${kind} expected revision is required.`);
  }
  if (actual !== expected) {
    throw conflict("revision_conflict", `${kind} revision ${expected} is stale; current is ${actual}.`);
  }
}

export function authorizeTask(actor: Actor, task: TaskView): void {
  requireProject(actor, task.projectId);
}

export function authorizeRequest(actor: Actor, request: RequestView): void {
  requireProject(actor, request.projectId);
  if (request.recipient["kind"] === "user" && request.recipient["userId"] !== actor.id) {
    throw forbidden("Only the named recipient can answer this request.");
  }
  if (actor.role === "runtime" && request.kind === "approval") {
    throw forbidden("A runtime principal cannot approve its own privileged action.");
  }
}

export function authorizeSessionControl(actor: Actor, session: SessionView): void {
  requireProject(actor, session.projectId);
  if (session.controlMode !== "control") {
    throw forbidden("The session is attached in view-only mode.");
  }
}

export function requireBindingGeneration(actual: number, expected: number | undefined): void {
  if (expected === undefined || expected !== actual) {
    throw conflict("binding_generation_conflict", "The runtime binding generation changed.");
  }
}

export function requireRuntimeTargetScope(
  actor: Actor,
  session: SessionView,
  attemptId?: string,
): void {
  if (actor.role !== "runtime") return;
  if (
    actor.sessionId !== session.id ||
    actor.bindingGeneration !== session.bindingGeneration ||
    (actor.attemptId !== undefined && actor.attemptId !== attemptId)
  ) {
    throw forbidden("The runtime credential is not scoped to this session, attempt, and generation.");
  }
}
