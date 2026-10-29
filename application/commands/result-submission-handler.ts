import { InputSnapshotSchema } from "../contracts/runtime.ts";
import type { Actor } from "../domain/authorization.ts";
import { commandTargetId } from "../domain/commands.ts";
import { conflict, forbidden } from "../domain/errors.ts";
import { digest } from "../persistence/codec.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { LifecycleRepository } from "../persistence/lifecycle-repository.ts";
import type { ResultRepository } from "../persistence/result-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import { authorizeTask, requireRuntimeTargetScope } from "./guards.ts";
import type { CommandOf, CommandResult } from "./types.ts";

export class ResultSubmissionHandler {
  private readonly dependencies: {
    readonly work: WorkRepository;
    readonly execution: ExecutionRepository;
    readonly results: ResultRepository;
    readonly lifecycle: LifecycleRepository;
  };

  constructor(dependencies: {
    readonly work: WorkRepository;
    readonly execution: ExecutionRepository;
    readonly results: ResultRepository;
    readonly lifecycle: LifecycleRepository;
  }) {
    this.dependencies = dependencies;
  }

  submit(actor: Actor, command: CommandOf<"result.submit">): CommandResult {
    const attemptId = commandTargetId(command, "attempt");
    const attempt = this.dependencies.execution.getAttempt(actor.workspaceId, attemptId);
    const task = this.dependencies.work.getTask(actor.workspaceId, attempt.taskId);
    authorizeTask(actor, task);
    const session = this.dependencies.execution.getSession(actor.workspaceId, attempt.sessionId);
    requireRuntimeTargetScope(actor, session, attempt.id);
    if (!this.dependencies.work.validateSelectedReferences(actor.workspaceId, task.id,
      command.payload.referenceIds)) {
      throw conflict("result_reference_invalid", "Result references must belong to the same task and remain available.");
    }
    const criterionIds = new Set(this.dependencies.lifecycle.currentCriteria(actor.workspaceId, task.id)
      .map((criterion) => criterion.id));
    if (command.payload.criterionEvidence.some((item) => !criterionIds.has(item.criterionId) ||
      !this.dependencies.work.validateSelectedReferences(actor.workspaceId, task.id, item.referenceIds))) {
      throw conflict("result_criterion_evidence_invalid",
        "Criterion evidence must bind current task criteria and references.");
    }
    if (actor.role === "runtime" && command.payload.evidence.some((item) => item.origin !== "agent_claim")) {
      throw forbidden("Bridge result statements are agent claims, not independently verified checks or human assertions.");
    }
    const snapshot = InputSnapshotSchema.safeParse(attempt.inputSnapshot);
    const snapshotData = snapshot.success ? snapshot.data : undefined;
    const verification = snapshotData?.verification;
    const bindingFields = [command.payload.submissionKey, command.payload.inputDigest,
      command.payload.actualCommit, command.payload.actualContextDigest];
    if (verification !== undefined && bindingFields.some((field) => field === undefined)) {
      throw conflict("result_binding_required",
        "Verification results require submission key, input digest, actual commit, and actual context digest.");
    }
    if (verification !== undefined && (command.payload.inputDigest !== snapshotData?.digest ||
      command.payload.actualCommit !== verification.sourceCommit ||
      command.payload.actualContextDigest !== verification.contextDigest)) {
      throw conflict("result_binding_mismatch",
        "Result source or context does not match the immutable verification input.");
    }
    if (verification !== undefined && command.payload.artifacts.some((artifact) =>
      artifact.repositoryId !== verification.repositoryId ||
      artifact.sourceCommit !== verification.sourceCommit)) {
      throw conflict("result_artifact_binding_mismatch",
        "Result artifacts must identify the exact repository and source commit from the verification input.");
    }
    const binding = verification === undefined ? undefined : {
      inputDigest: snapshotData?.digest, repositoryId: verification.repositoryId,
      repositoryRevision: verification.repositoryRevision, sourceCommit: verification.sourceCommit,
      contextDigest: verification.contextDigest, targetDigest: digest({ sessionId: session.id,
        generation: session.bindingGeneration, profileId: attempt.profileId,
        profileRevision: attempt.profileRevision }),
    };
    const submissionDigest = digest({ outcome: command.payload.outcome, kind: command.payload.kind,
      criterionEvidence: command.payload.criterionEvidence, summary: command.payload.summary,
      limitations: command.payload.limitations, referenceIds: command.payload.referenceIds,
      artifacts: command.payload.artifacts, evidence: command.payload.evidence, binding });
    const result = this.dependencies.results.create({ workspaceId: actor.workspaceId,
      taskId: task.id, attemptId, authorId: actor.id, summary: command.payload.summary,
      limitations: command.payload.limitations, referenceIds: command.payload.referenceIds,
      evidence: command.payload.evidence, artifacts: command.payload.artifacts,
      outcome: command.payload.outcome, kind: command.payload.kind,
      criterionEvidence: command.payload.criterionEvidence,
      ...(command.payload.submissionKey === undefined ? {} : {
        submissionKey: command.payload.submissionKey, submissionDigest }),
      ...(binding === undefined ? {} : { binding }) });
    return { status: "confirmed", confirmedEffect: "result.persisted",
      objectRefs: [{ kind: "result", id: result.id }], operationIds: [] };
  }
}
