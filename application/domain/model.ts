import type { HubErrorData } from "./errors.ts";
import type {
  CriterionEvidenceView,
  InterruptionKind,
  RecoveryKind,
  ResultKind,
} from "./lifecycle-model.ts";

export type TaskStatus = "backlog" | "active" | "review" | "done" | "canceled";
export type AttemptPhase =
  | "queued"
  | "preparing"
  | "opening_session"
  | "observing"
  | "running"
  | "waiting_input"
  | "finished";
export type AttemptOutcome =
  | "result_submitted"
  | "failed"
  | "canceled"
  | "ended_without_result";
export type ObservationState = "fresh" | "stale" | "unreachable" | "unknown";
export type OperationStatus =
  | "accepted"
  | "running"
  | "confirmed"
  | "rejected"
  | "failed"
  | "unknown";

export type TaskView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly expectedOutcome?: string;
  readonly priority?: number;
  readonly ownerId?: string;
  readonly status: TaskStatus;
  readonly businessIntentEpoch: number;
  readonly scopeRevision: number;
  readonly primaryAttemptId?: string;
  readonly archivedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RequestView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly attemptId?: string;
  readonly bindingGeneration?: number;
  readonly revision: number;
  readonly kind: "question" | "approval";
  readonly authorId: string;
  readonly recipient: Readonly<Record<string, unknown>>;
  readonly prompt: string;
  readonly reason?: string;
  readonly answerSchema: Readonly<Record<string, unknown>>;
  readonly blocking: "none" | "before_delegate" | "runtime_action";
  readonly validity: Readonly<Record<string, unknown>>;
  readonly status: "open" | "answered" | "withdrawn" | "expired" | "superseded";
  readonly responseRoute: "none" | "native" | "bridge";
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type SessionView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly runtimeInstallationId: string;
  readonly profileId?: string;
  readonly profileRevision?: number;
  readonly nativeIdentityKey?: string;
  readonly lifecycle: "opening" | "open" | "closed";
  readonly controlMode: "observe" | "control";
  readonly bindingGeneration: number;
  readonly activeAttemptId?: string;
  readonly predecessorId?: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AttemptView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly role: "primary" | "observed";
  readonly origin: "hub_started" | "attached_existing";
  readonly phase: AttemptPhase;
  readonly outcome?: AttemptOutcome;
  readonly observation: ObservationState;
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
  readonly predecessorId?: string;
  readonly unresolved: boolean;
  readonly interruption?: InterruptionKind;
  readonly recovery: RecoveryKind;
  readonly retryOrdinal: number;
  readonly retryLimit: number;
  readonly retryReason?: string;
  readonly stopRequestedAt?: string;
  readonly observationEndedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type EnvironmentRegistrationView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly label: string;
  readonly executionInstallationId: string;
  readonly allowedProjectIds: readonly string[];
  readonly allowedWorkAreas: readonly Readonly<Record<string, unknown>>[];
  readonly allowRuntimeServiceLaunch: boolean;
  readonly verifiedIdentity?: Readonly<Record<string, unknown>>;
  readonly verifiedAt?: string;
  readonly weakIdentityExplicitlyAccepted: boolean;
  readonly retiredAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type EnvironmentBindingView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly attemptId?: string;
  readonly sourceKind: "registration" | "allocation";
  readonly sourceId?: string;
  readonly identity?: Readonly<Record<string, unknown>>;
  readonly lifecycleGrant?: Readonly<Record<string, unknown>>;
  readonly useGrant?: Readonly<Record<string, unknown>>;
  readonly workAreaKeys: readonly string[];
  readonly accessMode: "read" | "write";
  readonly generation: number;
  readonly state:
    | "requested"
    | "waiting"
    | "attached"
    | "detaching"
    | "detached"
    | "releasing"
    | "released"
    | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ResultView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly authorId: string;
  readonly summary: string;
  readonly limitations: readonly string[];
  readonly referenceIds: readonly string[];
  readonly evidence: readonly Readonly<Record<string, unknown>>[];
  readonly artifacts: readonly Readonly<Record<string, unknown>>[];
  readonly outcome: "passed" | "failed" | "partial" | "blocked" | "unspecified";
  readonly kind: ResultKind;
  readonly criterionEvidence: readonly CriterionEvidenceView[];
  readonly submissionKey?: string;
  readonly binding?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
};

export type ExecutionProfileView = {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly runtimeInstallationId: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly allowedEnvironmentModes: readonly ("provision" | "existing" | "none")[];
  readonly defaultEnvironment: Readonly<Record<string, unknown>>;
  readonly requiredCapabilities: readonly string[];
  readonly allowedEffects: readonly string[];
};

export type HubCommandReceipt = {
  readonly commandId: string;
  readonly actorId: string;
  readonly status: OperationStatus;
  readonly confirmedEffect?: string | undefined;
  readonly objectRefs: readonly {
    readonly kind: string;
    readonly id: string;
    readonly revision?: number | undefined;
  }[];
  readonly operationIds: readonly string[];
  readonly error?: HubErrorData | undefined;
};

export type DashboardView = {
  readonly answerNeeded: readonly RequestView[];
  readonly approvalNeeded: readonly RequestView[];
  readonly deliveryProblems: readonly Readonly<Record<string, unknown>>[];
  readonly activeAttempts: readonly AttemptView[];
  readonly resultsToReview: readonly Readonly<Record<string, unknown>>[];
  readonly operationalIssues: readonly Readonly<Record<string, unknown>>[];
  readonly snapshotCursor: string;
};

export type HubSnapshot = {
  readonly projects?: readonly Readonly<Record<string, unknown>>[];
  readonly users?: readonly Readonly<Record<string, unknown>>[];
  readonly tasks: readonly TaskView[];
  readonly entries?: readonly Readonly<Record<string, unknown>>[];
  readonly requests: readonly RequestView[];
  readonly responses?: readonly Readonly<Record<string, unknown>>[];
  readonly deliveries?: readonly Readonly<Record<string, unknown>>[];
  readonly sessions: readonly SessionView[];
  readonly attempts: readonly AttemptView[];
  readonly environmentRegistrations: readonly EnvironmentRegistrationView[];
  readonly environmentBindings: readonly EnvironmentBindingView[];
  readonly results: readonly ResultView[];
  readonly references?: readonly Readonly<Record<string, unknown>>[];
  readonly output?: readonly Readonly<Record<string, unknown>>[];
  readonly operations?: readonly Readonly<Record<string, unknown>>[];
  readonly profiles: readonly ExecutionProfileView[];
  readonly dashboard: DashboardView;
};
