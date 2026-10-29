import type { Answer } from '../contracts/runtime.ts';
import type { VerificationEnvelope } from '../contracts/handoff.ts';
import type {
  BlockerView,
  CriterionEvidenceView,
  ResultAcceptanceView,
  ResultKind,
  TaskAmendmentView,
  TaskCriterionView,
} from '../domain/lifecycle-model.ts';
import type { TaskView } from '../domain/model.ts';

export const templateIds = [
  'task_brief',
  'status_result',
  'question_block',
  'answer_continuation',
  'verifier_handoff',
  'fix_incomplete',
] as const;

export type TemplateId = (typeof templateIds)[number];
export type TemplateVersion = 1;
export type PromptPresentationOverride = {
  readonly header?: string;
  readonly footer?: string;
};

export type PromptTask = Pick<TaskView,
  'id' | 'revision' | 'scopeRevision' | 'title' | 'description' | 'expectedOutcome'>;

export type TaskBriefInput = {
  readonly task: PromptTask;
  readonly attemptId: string;
  readonly instruction: string;
  readonly execution: {
    readonly profileId: string;
    readonly profileRevision: number;
    readonly runtimeInstallationId: string;
    readonly environment: unknown;
  };
  readonly amendments: readonly TaskAmendmentView[];
  readonly criteria: readonly TaskCriterionView[];
  readonly context: readonly { readonly id: string; readonly text: string }[];
};

export type StatusResultInput = {
  readonly taskId: string;
  readonly attemptId: string;
  readonly kind: ResultKind;
  readonly summary: string;
  readonly criterionEvidence: readonly CriterionEvidenceView[];
  readonly referenceIds: readonly string[];
  readonly source?: {
    readonly repositoryId: string;
    readonly repositoryRevision: number;
    readonly branch: string;
    readonly commit: string;
  };
  readonly environment?: { readonly identity: string; readonly status: string };
};

type RequestContext = {
  readonly taskId: string;
  readonly attemptId: string;
  readonly requestId: string;
  readonly pendingCriteria: readonly TaskCriterionView[];
};

export type QuestionBlockInput = RequestContext & (
  { readonly kind: 'question'; readonly prompt: string; readonly reason?: string } |
  { readonly kind: 'block'; readonly blocker: BlockerView }
);

export type AnswerContinuationInput = {
  readonly taskId: string;
  readonly attemptId: string;
  readonly requestId: string;
  readonly acceptedAnswer: Answer;
  readonly scopeRevision: number;
  readonly completedWork: readonly string[];
  readonly pendingCriteria: readonly TaskCriterionView[];
};

export type VerifierHandoffInput = {
  readonly task: TaskBriefInput['task'];
  readonly repository: {
    readonly id: string;
    readonly projectId: string;
    readonly canonicalIdentity: string;
    readonly revision: number;
  };
  readonly verification: VerificationEnvelope;
};

export type FixIncompleteInput = {
  readonly attemptId: string;
  readonly acceptance: ResultAcceptanceView;
  readonly pendingCriteria: readonly TaskCriterionView[];
  readonly referenceIds: readonly string[];
};

export type PromptTemplateInputMap = {
  readonly task_brief: TaskBriefInput;
  readonly status_result: StatusResultInput;
  readonly question_block: QuestionBlockInput;
  readonly answer_continuation: AnswerContinuationInput;
  readonly verifier_handoff: VerifierHandoffInput;
  readonly fix_incomplete: FixIncompleteInput;
};

export type PromptOutputContract = {
  readonly channels: readonly ['checkpoint', 'final', 'criteria', 'block'];
  readonly lifecycleSignals: 'structured_only';
};

export type RenderedPrompt<T extends TemplateId = TemplateId> = {
  readonly templateId: T;
  readonly version: TemplateVersion;
  readonly text: string;
  readonly digest: string;
  readonly inputDigest: string;
  readonly output: PromptOutputContract;
};
