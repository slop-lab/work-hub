export type CriterionRequirement = "required" | "optional";
export type VerificationRequirement = "required" | "optional";
export type ResultKind = "checkpoint" | "final";
export type CriterionEvidenceStatus = "satisfied" | "not_satisfied" | "not_verified";
export type AcceptanceDecision = "accepted" | "incomplete" | "rejected";
export type BlockerKind =
  | "environment"
  | "permission"
  | "external_dependency"
  | "task_dependency"
  | "capacity"
  | "provider_unknown"
  | "child_work";
export type BlockerStatus = "open" | "resolved" | "rechecking";
export type InterruptionKind =
  | "paused"
  | "awaiting_input"
  | "provider_stop"
  | "operator_stop"
  | "retryable_failure"
  | "crash"
  | "unknown";
export type RecoveryKind = "none" | "observe" | "reconcile" | "resume" | "retry" | "escalated";

export type TaskCriterionView = {
  readonly id: string;
  readonly taskId: string;
  readonly amendmentId: string;
  readonly key: string;
  readonly description: string;
  readonly requirement: CriterionRequirement;
  readonly verification: VerificationRequirement;
  readonly supersededByCriterionId?: string;
  readonly createdAt: string;
};

export type TaskAmendmentView = {
  readonly id: string;
  readonly taskId: string;
  readonly revision: number;
  readonly authorId: string;
  readonly summary: string;
  readonly criteria: readonly TaskCriterionView[];
  readonly supersedesCriterionIds: readonly string[];
  readonly createdAt: string;
};

export type CriterionEvidenceView = {
  readonly criterionId: string;
  readonly status: CriterionEvidenceStatus;
  readonly detail: string;
  readonly referenceIds: readonly string[];
};

export type ResultAcceptanceView = {
  readonly id: string;
  readonly taskId: string;
  readonly resultId: string;
  readonly actorId: string;
  readonly decision: AcceptanceDecision;
  readonly missingCriteria: readonly string[];
  readonly note?: string;
  readonly createdAt: string;
};

export type BlockerView = {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly kind: BlockerKind;
  readonly owner: string;
  readonly remedy: string;
  readonly detail: string;
  readonly status: BlockerStatus;
  readonly resolution?: string;
  readonly recheckNote?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AttemptLifecycleView = {
  readonly id: string;
  readonly interruption?: InterruptionKind;
  readonly recovery: RecoveryKind;
  readonly retry: {
    readonly ordinal: number;
    readonly limit: number;
    readonly reason?: string;
  };
};

export type TaskLifecycleView = {
  readonly taskId: string;
  readonly scopeRevision: number;
  readonly amendments: readonly TaskAmendmentView[];
  readonly criteria: readonly TaskCriterionView[];
  readonly acceptance?: ResultAcceptanceView;
  readonly blockers: readonly BlockerView[];
  readonly attempts: readonly AttemptLifecycleView[];
  readonly projection: {
    readonly currentMissingAction: "delegate_or_submit" | "await_execution" | "recover_attempt"
      | "resolve_blocker" | "review_result" | "revise_result" | "none";
    readonly responsibleOwner: string;
    readonly nextAction: string;
    readonly criterionCoverage: {
      readonly required: number;
      readonly satisfied: number;
      readonly missing: readonly string[];
    };
    readonly verificationRequired: boolean;
    readonly acceptanceMode: "human";
  };
};
