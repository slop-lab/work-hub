import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDelegation } from '../application/domain/delegation-policy.ts';
import type { DelegationContext } from '../application/contracts/index.ts';

const context: DelegationContext = {
  task: { id: 'task-one', revision: 1, title: 'Investigate', description: '' },
  profile: { id: 'profile-one', revision: 1, label: 'Test profile', runtimeInstallationId: 'runtime-one', runtimeConfiguration: {}, allowedEnvironmentModes: ['none', 'existing'], defaultEnvironment: { mode: 'none' }, requiredCapabilityNames: [], runtimeServiceLaunchOwner: 'external', nativeSessionLaunchOwner: 'runtime_connector', allowedOverridePaths: ['environment'], allowedEffectKinds: ['task.read', 'work.write'], inputPolicyId: 'manual-single-attempt', inputPolicyVersion: '1' },
  selection: { mode: 'none' }, actorAllowedEffectKinds: ['task.read'], unresolvedBlockingRequestIds: [], selectedReferenceIds: [], selectedResponseIds: [], readOnlyContext: {},
};
test('the pure policy proposes environment-free work without inventing infrastructure effects', () => {
  const before = structuredClone(context);
  const decision = planDelegation(context);
  assert.equal(decision.kind, 'proposal');
  if (decision.kind === 'proposal') { assert.deepEqual(decision.environment, { mode: 'none' }); assert.deepEqual(decision.requiredEffectKinds, ['task.read']); }
  assert.deepEqual(context, before);
});
test('the policy refuses a new attempt while unknown primary work exists', () => {
  const decision = planDelegation({ ...context, unresolvedPrimaryAttemptId: 'unknown-attempt' });
  assert.equal(decision.kind, 'denied');
  if (decision.kind === 'denied') assert.equal(decision.code, 'primary_attempt_unresolved');
});
test('a writable selection requires the intersection of actor and profile permissions', () => {
  const decision = planDelegation({ ...context, selection: { mode: 'existing', registrationId: 'environment-one', expectedRegistrationRevision: 1, requestedAccess: 'write', workAreas: [] } });
  assert.equal(decision.kind, 'denied');
  if (decision.kind === 'denied') assert.equal(decision.code, 'effect_not_authorized');
});
