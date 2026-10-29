import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type {
  AcceptanceDecision,
  BlockerKind,
  BlockerView,
  CriterionRequirement,
  RecoveryKind,
  ResultAcceptanceView,
  TaskAmendmentView,
  TaskCriterionView,
  TaskLifecycleView,
  VerificationRequirement,
  InterruptionKind,
} from "../domain/lifecycle-model.ts";
import { conflict } from "../domain/errors.ts";
import { buildLifecycleProjection } from "../domain/lifecycle-projection.ts";
import type { Clock } from "./codec.ts";
import { newId, parseJson } from "./codec.ts";
import { acceptanceRowSchema, amendmentRowSchema, blockerRowSchema,
  criterionRowSchema } from "./lifecycle-codec.ts";

type CriterionInput = {
  readonly key: string;
  readonly description: string;
  readonly requirement: CriterionRequirement;
  readonly verification: VerificationRequirement;
};

export class LifecycleRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  amend(input: { readonly workspaceId: string; readonly taskId: string; readonly authorId: string;
    readonly summary: string; readonly criteria: readonly CriterionInput[];
    readonly supersedesCriterionIds: readonly string[] }): TaskAmendmentView {
    const current = this.currentCriteria(input.workspaceId, input.taskId);
    const currentIds = new Set(current.map((criterion) => criterion.id));
    if (input.supersedesCriterionIds.some((id) => !currentIds.has(id))) {
      throw conflict("criterion_supersession_invalid", "Only current task criteria can be superseded.");
    }
    const duplicateKey = input.criteria.find((criterion) => current.some((existing) =>
      existing.key === criterion.key && !input.supersedesCriterionIds.includes(existing.id)));
    if (duplicateKey !== undefined) {
      throw conflict("criterion_key_conflict", `Criterion key ${duplicateKey.key} is already current.`);
    }
    const amendmentId = newId("amendment");
    const now = this.clock.now().toISOString();
    const revision = z.object({ revision: z.number() }).parse(this.database.prepare(
      "SELECT scope_revision + 1 AS revision FROM tasks WHERE workspace_id=? AND id=?",
    ).get(input.workspaceId, input.taskId)).revision;
    this.database.prepare(`INSERT INTO task_amendments
      (id,workspace_id,task_id,revision,author_id,summary,supersedes_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(amendmentId, input.workspaceId, input.taskId, revision,
      input.authorId, input.summary, JSON.stringify(input.supersedesCriterionIds), now);
    const createdIds: string[] = [];
    for (const criterion of input.criteria) {
      const id = newId("criterion");
      createdIds.push(id);
      this.database.prepare(`INSERT INTO task_criteria
        (id,workspace_id,task_id,amendment_id,criterion_key,description,requirement,
         verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, input.workspaceId,
        input.taskId, amendmentId, criterion.key, criterion.description, criterion.requirement,
        criterion.verification, now);
    }
    for (const [index, supersededId] of input.supersedesCriterionIds.entries()) {
      const replacementId = createdIds[index] ?? createdIds[0];
      if (replacementId === undefined) {
        throw conflict("criterion_replacement_required", "Superseded criteria require a replacement criterion.");
      }
      this.database.prepare(`UPDATE task_criteria SET superseded_by_criterion_id=?
        WHERE workspace_id=? AND task_id=? AND id=? AND superseded_by_criterion_id IS NULL`)
        .run(replacementId, input.workspaceId, input.taskId, supersededId);
    }
    this.database.prepare(`UPDATE tasks SET revision=revision+1,scope_revision=?,updated_at=?
      WHERE workspace_id=? AND id=?`).run(revision, now, input.workspaceId, input.taskId);
    return this.amendments(input.workspaceId, input.taskId).at(-1) as TaskAmendmentView;
  }

  currentCriteria(workspaceId: string, taskId: string): readonly TaskCriterionView[] {
    return this.database.prepare(`${this.criterionSelect()}
      WHERE workspace_id=? AND task_id=? AND superseded_by_criterion_id IS NULL
      ORDER BY created_at,id`).all(workspaceId, taskId).map((row) => this.toCriterion(row));
  }

  accept(input: { readonly workspaceId: string; readonly taskId: string; readonly resultId: string;
    readonly actorId: string; readonly decision: AcceptanceDecision;
    readonly missingCriteria: readonly string[]; readonly note?: string }): ResultAcceptanceView {
    const id = newId("acceptance");
    const now = this.clock.now().toISOString();
    this.database.prepare(`INSERT INTO result_acceptances
      (id,workspace_id,task_id,result_id,actor_id,decision,missing_criteria_json,note,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, input.workspaceId, input.taskId, input.resultId,
      input.actorId, input.decision, JSON.stringify(input.missingCriteria), input.note ?? null, now);
    return this.latestAcceptance(input.workspaceId, input.taskId) as ResultAcceptanceView;
  }

  openBlocker(input: { readonly workspaceId: string; readonly taskId: string;
    readonly attemptId?: string; readonly kind: BlockerKind; readonly owner: string;
    readonly remedy: string; readonly detail: string }): BlockerView {
    const id = newId("blocker");
    const now = this.clock.now().toISOString();
    this.database.prepare(`INSERT INTO blockers
      (id,workspace_id,task_id,attempt_id,kind,owner,remedy,detail,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'open',?,?)`).run(id, input.workspaceId, input.taskId,
      input.attemptId ?? null, input.kind, input.owner, input.remedy, input.detail, now, now);
    return this.getBlocker(input.workspaceId, id);
  }

  transitionBlocker(workspaceId: string, id: string, input:
    | { readonly status: "resolved"; readonly resolution: string }
    | { readonly status: "rechecking"; readonly note: string }): BlockerView {
    const blocker = this.getBlocker(workspaceId, id);
    if (input.status === "resolved" && blocker.status !== "open" && blocker.status !== "rechecking") {
      throw conflict("blocker_transition_invalid", "Only an open or rechecking blocker can be resolved.");
    }
    if (input.status === "rechecking" && blocker.status !== "resolved") {
      throw conflict("blocker_transition_invalid", "Only a resolved blocker can be rechecked.");
    }
    this.database.prepare(`UPDATE blockers SET status=?,resolution=?,recheck_note=?,updated_at=?
      WHERE workspace_id=? AND id=?`).run(input.status,
      input.status === "resolved" ? input.resolution : null,
      input.status === "rechecking" ? input.note : null,
      this.clock.now().toISOString(), workspaceId, id);
    return this.getBlocker(workspaceId, id);
  }

  reconcileAttempt(input: { readonly workspaceId: string; readonly attemptId: string;
    readonly interruption: InterruptionKind; readonly recovery: RecoveryKind }): void {
    this.database.prepare(`UPDATE attempts SET interruption_kind=?,recovery_kind=?,updated_at=?
      WHERE workspace_id=? AND id=?`).run(input.interruption, input.recovery,
      this.clock.now().toISOString(), input.workspaceId, input.attemptId);
  }

  controlledResume(input: { readonly workspaceId: string; readonly attemptId: string;
    readonly recovery: Extract<RecoveryKind, "resume" | "retry" | "escalated">;
    readonly reason: string; readonly retryLimit: number }): void {
    const attempt = z.object({ retryOrdinal: z.number() }).parse(this.database.prepare(
      "SELECT retry_ordinal AS retryOrdinal FROM attempts WHERE workspace_id=? AND id=?",
    ).get(input.workspaceId, input.attemptId));
    const ordinal = input.recovery === "retry" ? attempt.retryOrdinal + 1 : attempt.retryOrdinal;
    if (ordinal > input.retryLimit) throw conflict("retry_budget_exhausted", "Retry budget is exhausted.");
    this.database.prepare(`UPDATE attempts SET recovery_kind=?,retry_ordinal=?,retry_limit=?,
      retry_reason=?,updated_at=? WHERE workspace_id=? AND id=?`).run(input.recovery, ordinal,
      input.retryLimit, input.reason, this.clock.now().toISOString(), input.workspaceId, input.attemptId);
  }

  recordRetry(input: { readonly workspaceId: string; readonly attemptId: string;
    readonly predecessorOrdinal: number; readonly limit: number; readonly reason: string }): void {
    const ordinal = input.predecessorOrdinal + 1;
    if (ordinal > input.limit) throw conflict("retry_budget_exhausted", "Retry budget is exhausted.");
    this.database.prepare(`UPDATE attempts SET recovery_kind='retry',retry_ordinal=?,retry_limit=?,
      retry_reason=?,updated_at=? WHERE workspace_id=? AND id=?`).run(ordinal, input.limit,
      input.reason, this.clock.now().toISOString(), input.workspaceId, input.attemptId);
  }

  view(workspaceId: string, taskId: string): TaskLifecycleView {
    const task = z.object({ scopeRevision: z.number(), primaryAttemptId: z.string().nullable() }).parse(
      this.database.prepare(`SELECT scope_revision AS scopeRevision,primary_attempt_id AS primaryAttemptId
        FROM tasks WHERE workspace_id=? AND id=?`).get(workspaceId, taskId));
    const attempts = this.database.prepare(`SELECT id,interruption_kind AS interruption,
      recovery_kind AS recovery,retry_ordinal AS ordinal,retry_limit AS retryLimit,
      retry_reason AS reason FROM attempts WHERE workspace_id=? AND task_id=? ORDER BY created_at,id`)
      .all(workspaceId, taskId).map((row) => z.object({ id: z.string(), interruption: z.string().nullable(),
        recovery: z.enum(["none", "observe", "reconcile", "resume", "retry", "escalated"]),
        ordinal: z.number(), retryLimit: z.number(), reason: z.string().nullable() }).parse(row))
      .map((attempt) => ({ id: attempt.id,
        ...(attempt.interruption === null ? {} : { interruption: z.enum(["paused", "awaiting_input",
          "provider_stop", "operator_stop", "retryable_failure", "crash", "unknown"]).parse(attempt.interruption) }),
        recovery: attempt.recovery, retry: { ordinal: attempt.ordinal, limit: attempt.retryLimit,
          ...(attempt.reason === null ? {} : { reason: attempt.reason }) } }));
    const acceptance = this.latestAcceptance(workspaceId, taskId);
    const criteria = this.currentCriteria(workspaceId, taskId);
    const latestResult = task.primaryAttemptId === null ? undefined :
      z.object({ criterionEvidenceJson: z.string() }).optional().parse(
        this.database.prepare(`SELECT criterion_evidence_json AS criterionEvidenceJson FROM results
          WHERE workspace_id=? AND task_id=? AND attempt_id=? ORDER BY created_at DESC,id DESC LIMIT 1`)
          .get(workspaceId, taskId, task.primaryAttemptId));
    const evidence = latestResult === undefined ? [] : z.array(z.object({ criterionId: z.string(),
      status: z.enum(["satisfied", "not_satisfied", "not_verified"]) }).passthrough())
      .parse(parseJson(latestResult.criterionEvidenceJson));
    const satisfied = new Set(evidence.filter((item) => item.status === "satisfied")
      .map((item) => item.criterionId));
    const blockers = this.blockers(workspaceId, taskId);
    const active = z.object({ present: z.number() }).parse(this.database.prepare(
      "SELECT EXISTS(SELECT 1 FROM attempts WHERE workspace_id=? AND task_id=? AND unresolved=1) AS present",
    ).get(workspaceId, taskId)).present === 1;
    const projectionAttempts = task.primaryAttemptId === null ? [] :
      attempts.filter((attempt) => attempt.id === task.primaryAttemptId);
    const projection = buildLifecycleProjection({ criteria, satisfiedCriterionIds: satisfied,
      blockers, ...(acceptance === undefined ? {} : { acceptance }), attempts: projectionAttempts, active,
      hasResult: latestResult !== undefined });
    return { taskId, scopeRevision: task.scopeRevision, amendments: this.amendments(workspaceId, taskId),
      criteria, ...(acceptance === undefined ? {} : { acceptance }), blockers, attempts,
      projection };
  }

  private amendments(workspaceId: string, taskId: string): readonly TaskAmendmentView[] {
    return this.database.prepare(`SELECT id,task_id AS taskId,revision,author_id AS authorId,
      summary,supersedes_json AS supersedesJson,created_at AS createdAt FROM task_amendments
      WHERE workspace_id=? AND task_id=? ORDER BY revision,id`).all(workspaceId, taskId).map((row) => {
      const value = amendmentRowSchema.parse(row);
      return { id: value.id, taskId: value.taskId, revision: value.revision, authorId: value.authorId,
        summary: value.summary, criteria: this.criteriaForAmendment(workspaceId, value.id),
        supersedesCriterionIds: z.array(z.string()).parse(parseJson(value.supersedesJson)), createdAt: value.createdAt };
    });
  }

  private criteriaForAmendment(workspaceId: string, amendmentId: string): readonly TaskCriterionView[] {
    return this.database.prepare(`${this.criterionSelect()} WHERE workspace_id=? AND amendment_id=?
      ORDER BY created_at,id`).all(workspaceId, amendmentId).map((row) => this.toCriterion(row));
  }

  private criterionSelect(): string {
    return `SELECT id,task_id AS taskId,amendment_id AS amendmentId,criterion_key AS key,
      description,requirement,verification,superseded_by_criterion_id AS supersededByCriterionId,
      created_at AS createdAt FROM task_criteria`;
  }

  private toCriterion(row: unknown): TaskCriterionView {
    const value = criterionRowSchema.parse(row);
    return { id: value.id, taskId: value.taskId, amendmentId: value.amendmentId, key: value.key,
      description: value.description, requirement: value.requirement, verification: value.verification,
      ...(value.supersededByCriterionId === null ? {} : { supersededByCriterionId: value.supersededByCriterionId }),
      createdAt: value.createdAt };
  }

  private latestAcceptance(workspaceId: string, taskId: string): ResultAcceptanceView | undefined {
    const row = this.database.prepare(`SELECT id,task_id AS taskId,result_id AS resultId,
      actor_id AS actorId,decision,missing_criteria_json AS missingCriteriaJson,note,
      created_at AS createdAt FROM result_acceptances WHERE workspace_id=? AND task_id=?
      ORDER BY created_at DESC,id DESC LIMIT 1`).get(workspaceId, taskId);
    if (row === undefined) return undefined;
    const value = acceptanceRowSchema.parse(row);
    return { id: value.id, taskId: value.taskId, resultId: value.resultId, actorId: value.actorId,
      decision: value.decision, missingCriteria: z.array(z.string()).parse(parseJson(value.missingCriteriaJson)),
      ...(value.note === null ? {} : { note: value.note }), createdAt: value.createdAt };
  }

  private blockers(workspaceId: string, taskId: string): readonly BlockerView[] {
    return this.database.prepare(`${this.blockerSelect()} WHERE workspace_id=? AND task_id=?
      ORDER BY updated_at DESC,id`).all(workspaceId, taskId).map((row) => this.toBlocker(row));
  }

  private getBlocker(workspaceId: string, id: string): BlockerView {
    return this.toBlocker(this.database.prepare(`${this.blockerSelect()} WHERE workspace_id=? AND id=?`)
      .get(workspaceId, id));
  }

  private blockerSelect(): string {
    return `SELECT id,task_id AS taskId,attempt_id AS attemptId,kind,owner,remedy,detail,status,
      resolution,recheck_note AS recheckNote,created_at AS createdAt,updated_at AS updatedAt FROM blockers`;
  }

  private toBlocker(row: unknown): BlockerView {
    const value = blockerRowSchema.parse(row);
    return { id: value.id, taskId: value.taskId,
      ...(value.attemptId === null ? {} : { attemptId: value.attemptId }), kind: value.kind,
      owner: value.owner, remedy: value.remedy, detail: value.detail, status: value.status,
      ...(value.resolution === null ? {} : { resolution: value.resolution }),
      ...(value.recheckNote === null ? {} : { recheckNote: value.recheckNote }),
      createdAt: value.createdAt, updatedAt: value.updatedAt };
  }
}
