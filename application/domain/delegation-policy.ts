import type { DelegationContext, DelegationPlan, DelegationPolicy } from '../contracts/index.ts';

export function planDelegation(context: Readonly<DelegationContext>): DelegationPlan {
  if (context.unresolvedPrimaryAttemptId) return { kind: 'denied', code: 'primary_attempt_unresolved', reason: 'Reconcile or continue the existing primary attempt before delegating again.' };
  if (context.unresolvedBlockingRequestIds.length) return { kind: 'denied', code: 'blocking_requests', reason: 'Answer or explicitly withdraw the blocking questions before delegation.' };
  if (!context.profile.allowedEnvironmentModes.includes(context.selection.mode)) return { kind: 'denied', code: 'environment_mode_denied', reason: 'This profile does not allow the selected environment mode.' };
  let writes = false;
  switch (context.selection.mode) {
    case 'none': break;
    case 'existing': writes = context.selection.requestedAccess === 'write'; break;
    case 'provision': writes = context.selection.workAreas.some((area) => area.requestedAccess === 'write'); break;
    default: return assertNever(context.selection);
  }
  const requiredEffectKinds = writes ? ['task.read', 'work.write'] : ['task.read'];
  if (requiredEffectKinds.some((effect) => !context.actorAllowedEffectKinds.includes(effect) || !context.profile.allowedEffectKinds.includes(effect))) return { kind: 'denied', code: 'effect_not_authorized', reason: 'The actor and profile must both permit the selected read/write effects.' };
  const instruction = [context.task.title, context.task.description, context.task.expectedOutcome ?? ''].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(instruction) > 131072) return { kind: 'denied', code: 'input_too_large', reason: 'The task brief exceeds 128 KiB. Shorten or select context explicitly; nothing is truncated.' };
  return { kind: 'proposal', profileId: context.profile.id, profileRevision: context.profile.revision, environment: context.selection, instruction, selectedReferenceIds: [...context.selectedReferenceIds], selectedResponseIds: [...context.selectedResponseIds], requiredEffectKinds };
}

export const singleAttemptPolicy: DelegationPolicy = {
  id: 'manual-single-attempt', version: '1',
  async plan(context) { return planDelegation(context); },
};
function assertNever(value: never): never { throw new TypeError(`Unexpected selection ${String(value)}`); }
