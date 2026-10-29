import { NativeRefSchema } from "../contracts/common.ts";
import type { HandoffRecipient, VerificationEnvelope } from "../contracts/handoff.ts";
import type { Actor } from "../domain/authorization.ts";
import { unsupported } from "../domain/errors.ts";
import { digest } from "../persistence/codec.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { HandoffRepository } from "../persistence/handoff-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import type { RuntimeScope } from "./bridge-queries.ts";

export type RegisterRepositoryRequest = {
  readonly projectId: string; readonly canonicalIdentity: string;
};
export type HandoffPreviewRequest = {
  readonly taskId: string; readonly profileId: string; readonly repositoryId: string;
  readonly repositoryRevision: number; readonly sourceBranch: string; readonly sourceCommit: string;
  readonly requestedValidation: string; readonly contextDigest: string; readonly recipient: HandoffRecipient;
};
export type RecipientAssignmentRequest = {
  readonly workHubWorkspaceId: string; readonly targetWorkspaceId: string;
  readonly installationId: string; readonly hostId: string; readonly incarnation: string;
  readonly nativeSessionId: string;
};

export class HandoffService {
  private readonly execution: ExecutionRepository;
  private readonly handoffs: HandoffRepository;
  private readonly work: WorkRepository;

  constructor(input: {
    readonly execution: ExecutionRepository;
    readonly handoffs: HandoffRepository;
    readonly work: WorkRepository;
  }) {
    this.execution = input.execution;
    this.handoffs = input.handoffs;
    this.work = input.work;
  }

  registerRepository(actor: Actor, input: RegisterRepositoryRequest) {
    this.requireProject(actor, input.projectId);
    return this.handoffs.register({ workspaceId: actor.workspaceId, ...input });
  }
  listRepositories(actor: Actor, projectId: string) {
    this.requireProject(actor, projectId);
    return this.handoffs.listRepositories(actor.workspaceId, projectId);
  }

  preview(actor: Actor, input: HandoffPreviewRequest) {
    const task = this.work.getTask(actor.workspaceId, input.taskId);
    this.requireProject(actor, task.projectId);
    const profile = this.execution.getProfile(actor.workspaceId, input.profileId);
    const verification: VerificationEnvelope = {
      repositoryId: input.repositoryId, repositoryRevision: input.repositoryRevision,
      sourceBranch: input.sourceBranch, sourceCommit: input.sourceCommit,
      requestedValidation: input.requestedValidation, contextDigest: input.contextDigest,
    };
    const target = input.recipient.kind === "new"
      ? { kind: "new", runtimeInstallationId: profile.runtimeInstallationId,
          profileId: profile.id, profileRevision: profile.revision,
          readiness: "pending_session_creation", authority: "control",
          incarnation: "assigned_after_creation" }
      : this.attachedTarget(actor, input.recipient);
    return this.handoffs.preview({ workspaceId: actor.workspaceId, task, profile,
      repositoryId: input.repositoryId, repositoryRevision: input.repositoryRevision,
      verification, recipient: input.recipient, target });
  }

  get(actor: Actor, attemptId: string) {
    const attempt = this.execution.getAttempt(actor.workspaceId, attemptId);
    const task = this.work.getTask(actor.workspaceId, attempt.taskId);
    this.requireProject(actor, task.projectId);
    const preview = this.handoffs.previewForAttempt(actor.workspaceId, attempt.id);
    if (preview === undefined) throw unsupported("handoff_unavailable", "Attempt is not a verification handoff.");
    return { task, attempt, preview, delivery: this.handoffs.delivery(actor.workspaceId, attempt.id) };
  }

  list(actor: Actor, taskId: string) {
    const task = this.work.getTask(actor.workspaceId, taskId);
    this.requireProject(actor, task.projectId);
    return this.execution.attemptsForTask(actor.workspaceId, taskId)
      .flatMap((attempt) => this.handoffs.previewForAttempt(actor.workspaceId, attempt.id) === undefined
        ? [] : [this.get(actor, attempt.id)]);
  }

  assignment(input: RecipientAssignmentRequest) {
    const session = this.execution.listSessions(input.workHubWorkspaceId).find((candidate) => {
      if (candidate.runtimeInstallationId !== input.installationId || candidate.lifecycle !== "open" ||
        candidate.nativeIdentityKey === undefined) return false;
      const native = NativeRefSchema.parse(JSON.parse(candidate.nativeIdentityKey));
      return native.id === input.nativeSessionId && native.installationId === input.installationId &&
        native.incarnation === input.incarnation;
    });
    if (session === undefined || session.activeAttemptId === undefined) {
      throw unsupported("recipient_assignment_stale", "Recipient exchange target is not the exact current runtime attempt.");
    }
    const attempt = this.execution.getAttempt(input.workHubWorkspaceId, session.activeAttemptId);
    if (attempt.sessionId !== session.id || !attempt.unresolved) throw unsupported(
      "recipient_assignment_stale", "Recipient exchange target is not the exact current runtime attempt.");
    if (session.nativeIdentityKey === undefined) throw unsupported(
      "recipient_assignment_stale", "Recipient native session identity is unavailable.");
    const nativeSession = NativeRefSchema.parse(JSON.parse(session.nativeIdentityKey));
    const delivery = this.handoffs.deliveryOptional(input.workHubWorkspaceId, attempt.id);
    const deliveryDigest = typeof delivery?.["deliveryDigest"] === "string"
      ? delivery["deliveryDigest"] : digest({ attemptId: attempt.id, input: attempt.inputSnapshot });
    return { workHubWorkspaceId: input.workHubWorkspaceId, targetWorkspaceId: input.targetWorkspaceId,
      hostId: input.hostId, projectId: session.projectId, taskId: attempt.taskId,
      sessionId: session.id, sessionRevision: session.revision, attemptId: attempt.id,
      bindingGeneration: session.bindingGeneration, installationId: session.runtimeInstallationId,
      incarnation: input.incarnation, nativeSessionDigest: digest(nativeSession), deliveryDigest,
      profileId: attempt.profileId, profileRevision: attempt.profileRevision,
      inputSnapshot: attempt.inputSnapshot };
  }

  acknowledge(actor: Actor, input: { readonly attemptId: string; readonly deliveryDigest: string }): void {
    const attempt = this.execution.getAttempt(actor.workspaceId, input.attemptId);
    const session = this.execution.getSession(actor.workspaceId, attempt.sessionId);
    if (actor.role !== "runtime" || actor.attemptId !== attempt.id || actor.sessionId !== session.id ||
      actor.bindingGeneration !== session.bindingGeneration) {
      throw unsupported("recipient_assignment_stale", "Delivery acknowledgment is outside runtime scope.");
    }
    this.handoffs.acknowledge(actor.workspaceId, attempt.id, input.deliveryDigest);
  }

  assertScope(scope: RuntimeScope): void {
    const extended = [scope.installationId, scope.nativeSessionDigest,
      scope.deliveryDigest, scope.incarnation];
    if (extended.every((value) => value === undefined)) return;
    if (scope.installationId === undefined || scope.nativeSessionDigest === undefined ||
      scope.deliveryDigest === undefined || scope.incarnation === undefined) {
      throw unsupported("recipient_scope_incomplete", "Recipient bridge identity binding is incomplete.");
    }
    if (scope.targetWorkspaceId === undefined || scope.hostId === undefined ||
      scope.nativeSessionId === undefined) throw unsupported(
        "recipient_scope_incomplete", "Recipient bridge target identity binding is incomplete.");
    const assignment = this.assignment({ workHubWorkspaceId: scope.workspaceId,
      targetWorkspaceId: scope.targetWorkspaceId, installationId: scope.installationId,
      hostId: scope.hostId, incarnation: scope.incarnation,
      nativeSessionId: scope.nativeSessionId });
    if (assignment.projectId !== scope.projectId || assignment.taskId !== scope.taskId ||
      assignment.nativeSessionDigest !== scope.nativeSessionDigest ||
      assignment.deliveryDigest !== scope.deliveryDigest) {
      throw unsupported("recipient_scope_stale", "Recipient bridge identity no longer matches the current assignment.");
    }
  }

  private requireProject(actor: Actor, projectId: string): void {
    if (actor.role !== "administrator" && !actor.projectIds.includes(projectId)) {
      throw unsupported("project_unavailable", "Project is outside the actor scope.");
    }
  }
  private attachedTarget(actor: Actor, recipient: Extract<HandoffRecipient, { readonly kind: "attached" }>) {
    const session = this.execution.getSession(actor.workspaceId, recipient.sessionId);
    this.requireProject(actor, session.projectId);
    if (session.lifecycle !== "open" || session.controlMode !== "control") throw unsupported(
      "handoff_target_not_ready", "Attached handoff recipients require an open control session.");
    if (session.profileId !== recipient.profileId || session.profileRevision !== recipient.profileRevision) throw unsupported(
      "handoff_profile_mismatch", "Attached handoff recipient profile identity changed.");
    if (session.activeAttemptId !== undefined &&
      this.execution.getAttempt(actor.workspaceId, session.activeAttemptId).phase !== "finished") throw unsupported(
        "handoff_target_busy", "Attached handoff recipient still has unresolved active work.");
    const nativeSession = session.nativeIdentityKey === undefined ? undefined
      : NativeRefSchema.parse(JSON.parse(session.nativeIdentityKey));
    const nativeSessionDigest = nativeSession === undefined ? undefined : digest(nativeSession);
    return { kind: "attached", runtimeInstallationId: session.runtimeInstallationId,
      sessionId: session.id, sessionRevision: session.revision,
      bindingGeneration: session.bindingGeneration, profileId: recipient.profileId,
      profileRevision: recipient.profileRevision, readiness: "ready", authority: "control",
      incarnation: nativeSession?.incarnation ?? "not_reported",
      ...(nativeSessionDigest === undefined ? {} : { nativeSessionDigest }) };
  }
}
