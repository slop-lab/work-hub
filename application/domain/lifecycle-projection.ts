import type {
  AttemptLifecycleView,
  BlockerView,
  ResultAcceptanceView,
  TaskCriterionView,
  TaskLifecycleView,
} from "./lifecycle-model.ts";

type Projection = TaskLifecycleView["projection"];

export function buildLifecycleProjection(input: {
  readonly criteria: readonly TaskCriterionView[];
  readonly satisfiedCriterionIds: ReadonlySet<string>;
  readonly blockers: readonly BlockerView[];
  readonly acceptance?: ResultAcceptanceView;
  readonly attempts: readonly AttemptLifecycleView[];
  readonly active: boolean;
  readonly hasResult: boolean;
}): Projection {
  const required = input.criteria.filter((criterion) => criterion.requirement === "required");
  const missing = required.filter((criterion) => !input.satisfiedCriterionIds.has(criterion.id))
    .map((criterion) => criterion.id);
  const blocker = input.blockers.find((candidate) => candidate.status !== "resolved");
  const interrupted = input.attempts.some((attempt) => attempt.interruption !== undefined);
  const action = input.acceptance?.decision === "accepted"
    ? { currentMissingAction: "none" as const, responsibleOwner: "task_owner",
        nextAction: "No lifecycle action is pending." }
    : blocker !== undefined
    ? { currentMissingAction: "resolve_blocker" as const, responsibleOwner: blocker.owner,
        nextAction: blocker.remedy }
    : input.acceptance?.decision === "incomplete" || input.acceptance?.decision === "rejected"
      ? { currentMissingAction: "revise_result" as const, responsibleOwner: "result_author",
          nextAction: input.acceptance.note ?? "Submit a corrected final result." }
      : input.hasResult
        ? { currentMissingAction: "review_result" as const, responsibleOwner: "task_owner",
            nextAction: "Accept, reject, or mark the current result incomplete." }
        : interrupted
          ? { currentMissingAction: "recover_attempt" as const, responsibleOwner: "operator",
              nextAction: "Reconcile or deliberately resume the interrupted attempt." }
          : input.active
            ? { currentMissingAction: "await_execution" as const, responsibleOwner: "provider",
                nextAction: "Await a checkpoint, final result, question, or interruption." }
            : { currentMissingAction: "delegate_or_submit" as const, responsibleOwner: "task_owner",
                nextAction: "Delegate work or submit a result for review." };
  return { ...action, criterionCoverage: { required: required.length,
    satisfied: required.length - missing.length, missing },
    verificationRequired: input.criteria.some((criterion) => criterion.verification === "required"),
    acceptanceMode: "human" };
}
