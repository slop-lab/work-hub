import type { CriterionEvidenceView, TaskCriterionView } from "./lifecycle-model.ts";

export function criterionEvidenceSatisfies(
  criterion: TaskCriterionView,
  evidence: CriterionEvidenceView | undefined,
): boolean {
  return evidence?.status === "satisfied" &&
    (criterion.verification === "optional" || evidence.referenceIds.length > 0);
}
