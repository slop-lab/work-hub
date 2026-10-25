import { z } from 'zod';
import { TimestampSchema } from './common.ts';
import type { Id, JsonObject, Revision } from "./common.ts";
import type { ConnectorError } from "./common.ts";
import type { EnvironmentSelection } from "./execution.ts";
import type { RequestDraft } from "./runtime.ts";

export interface ExecutionProfileRevision { readonly id: Id; readonly revision: Revision; readonly label: string; readonly runtimeInstallationId: Id; readonly runtimeConfiguration: JsonObject; readonly allowedEnvironmentModes: readonly EnvironmentSelection["mode"][]; readonly defaultEnvironment: EnvironmentSelection; readonly requiredCapabilityNames: readonly string[]; readonly runtimeServiceLaunchOwner: "execution_provider" | "runtime_connector" | "external"; readonly nativeSessionLaunchOwner: "runtime_connector" | "execution_provider" | "external"; readonly allowedOverridePaths: readonly string[]; readonly allowedEffectKinds: readonly string[]; readonly inputPolicyId: string; readonly inputPolicyVersion: string; readonly releasePolicyRef?: string }
export interface DelegationContext { readonly task: { readonly id: Id; readonly revision: Revision; readonly title: string; readonly description: string; readonly expectedOutcome?: string }; readonly profile: ExecutionProfileRevision; readonly selection: EnvironmentSelection; readonly actorAllowedEffectKinds: readonly string[]; readonly unresolvedPrimaryAttemptId?: Id; readonly unresolvedBlockingRequestIds: readonly Id[]; readonly selectedReferenceIds: readonly Id[]; readonly selectedResponseIds: readonly Id[]; readonly readOnlyContext: JsonObject }
export type DelegationPlan = { readonly kind: "proposal"; readonly profileId: Id; readonly profileRevision: Revision; readonly environment: EnvironmentSelection; readonly instruction: string; readonly selectedReferenceIds: readonly Id[]; readonly selectedResponseIds: readonly Id[]; readonly requiredEffectKinds: readonly string[] } | { readonly kind: "needs_input"; readonly requests: readonly RequestDraft[] } | { readonly kind: "denied"; readonly code: string; readonly reason: string };
export interface DelegationPolicy { readonly id: string; readonly version: string; plan(context: Readonly<DelegationContext>): Promise<DelegationPlan> }
export interface ExpectedRevisions { readonly task?: Revision; readonly profile?: Revision; readonly request?: Revision; readonly registration?: Revision; readonly session?: Revision; readonly bindingGeneration?: number }
export interface HubCommand { readonly commandId: Id; readonly type: string; readonly target?: { readonly kind: string; readonly id: Id }; readonly expected?: ExpectedRevisions; readonly payload: JsonObject }
export interface HubCommandReceipt { readonly commandId: Id; readonly actorId: Id; readonly status: "accepted" | "running" | "confirmed" | "rejected" | "failed" | "unknown"; readonly confirmedEffect?: string | undefined; readonly objectRefs: readonly { readonly kind: string; readonly id: Id; readonly revision?: Revision | undefined }[]; readonly operationIds: readonly Id[]; readonly error?: ConnectorError | undefined }
export interface SurfaceContext { readonly sessionId: Id; readonly attemptId?: Id; readonly generation: number; readonly mode: "view" | "control"; readonly availableCommandTypes: readonly string[]; readonly eventCursor?: string }
export interface SurfaceChannel { readonly id: Id; readonly kind: "terminal" | "native_view"; readonly scopedBrowserEndpoint: string; readonly expiresAt: string; readonly allowedActions: readonly ("read" | "write_input" | "resize")[]; readonly inputReplay: "forbidden" }
export interface SessionSurface { readonly id: string; readonly contractMajor: 1; readonly kind: "transcript" | "terminal" | "native_view"; readonly requiredCapabilityNames: readonly string[]; openView(context: SurfaceContext): Promise<{ readonly viewId: Id; readonly channel?: SurfaceChannel; readonly outputCursor?: string }>; closeView(viewId: Id): Promise<void> }

export const SurfaceContextSchema = z.strictObject({
  sessionId: z.string().min(1), attemptId: z.string().min(1).optional(),
  generation: z.number().int().nonnegative(), mode: z.enum(['view', 'control']),
  availableCommandTypes: z.array(z.string().min(1)), eventCursor: z.string().optional(),
});
export const SurfaceChannelSchema = z.strictObject({
  id: z.string().min(1), kind: z.enum(['terminal', 'native_view']),
  scopedBrowserEndpoint: z.string().min(1), expiresAt: TimestampSchema,
  allowedActions: z.array(z.enum(['read', 'write_input', 'resize'])), inputReplay: z.literal('forbidden'),
});
export const SurfaceViewSchema = z.strictObject({
  viewId: z.string().min(1), channel: SurfaceChannelSchema.optional(), outputCursor: z.string().optional(),
});
