import { JsonObjectSchema } from '../contracts/index.ts';
import type { ExecutionProfileView, TaskView } from '../domain/model.ts';
import { environmentSelectionSchema } from '../domain/schema-common.ts';
import { planDelegation, singleAttemptPolicy } from '../domain/delegation-policy.ts';
import { conflict } from '../domain/errors.ts';
import type { CommandOf } from './types.ts';

export function acceptedDelegationPlan(input: { readonly task: TaskView; readonly profile: ExecutionProfileView; readonly command: CommandOf<'attempt.delegate'>; readonly unresolvedPrimaryAttemptId?: string }) {
  const { task, profile, command } = input;
  const decision = planDelegation({
    task: { id: task.id, revision: task.revision, title: task.title, description: task.description, ...(task.expectedOutcome ? { expectedOutcome: task.expectedOutcome } : {}) },
    profile: { id: profile.id, revision: profile.revision, label: profile.label, runtimeInstallationId: profile.runtimeInstallationId, runtimeConfiguration: JsonObjectSchema.parse(profile.configuration), allowedEnvironmentModes: [...profile.allowedEnvironmentModes], defaultEnvironment: environmentSelectionSchema.parse(profile.defaultEnvironment),
      requiredCapabilityNames: [...profile.requiredCapabilities], runtimeServiceLaunchOwner: 'external', nativeSessionLaunchOwner: 'runtime_connector', allowedOverridePaths: ['environment', 'instruction'], allowedEffectKinds: [...profile.allowedEffects], inputPolicyId: singleAttemptPolicy.id, inputPolicyVersion: singleAttemptPolicy.version },
    selection: command.payload.environment,
    actorAllowedEffectKinds: command.payload.authorizedEffectKinds.length ? [...command.payload.authorizedEffectKinds] : [...profile.allowedEffects],
    ...(input.unresolvedPrimaryAttemptId ? { unresolvedPrimaryAttemptId: input.unresolvedPrimaryAttemptId } : {}),
    unresolvedBlockingRequestIds: [], selectedReferenceIds: [...command.payload.selectedReferenceIds], selectedResponseIds: [...command.payload.selectedResponseIds], readOnlyContext: {},
  });
  switch (decision.kind) {
    case 'proposal': return decision;
    case 'denied': throw conflict(decision.code, decision.reason);
    case 'needs_input': throw conflict('delegation_needs_input', 'Answer the policy requests before delegation.');
    default: return assertNever(decision);
  }
}
function assertNever(value: never): never { throw new TypeError(`Unexpected delegation plan ${String(value)}`); }
