import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { ExecutionConnector } from '../application/contracts/index.ts';
import { createSimulators } from '../application/simulator/index.ts';
import { Hub } from '../application/orchestration/hub.ts';
import { drainIdle } from './acceptance-fixture.ts';

test('a provider-precreated native session is attached rather than recreated, and initial task input remains a distinct single operation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-hub-precreated-'));
  const simulator = createSimulators(join(directory, 'provider.sqlite'));
  const base = simulator.execution;
  const nativeSession = { installationId: 'runtime-sim-structured', providerScope: 'simulated', kind: 'agent-session', id: 'provider-precreated-one', incarnation: 'v1' };
  const execution: ExecutionConnector = {
    describe: () => base.describe(), probeExisting: (ctx, registration) => base.probeExisting(ctx, registration),
    requestAllocation: async (ctx, input) => {
      const receipt = await base.requestAllocation(ctx, input);
      if (receipt.status !== 'confirmed') return receipt;
      simulator.controls.seedSession({ hubSessionId: input.sessionId, nativeSession, controlMode: 'control', phase: 'idle' });
      return { ...receipt, result: { ...receipt.result, precreatedNativeSession: nativeSession } };
    },
    attach: (ctx, input) => base.attach(ctx, input), inspectBinding: (ctx, attachment) => base.inspectBinding(ctx, attachment), lookupOperation: (ctx, id) => base.lookupOperation(ctx, id), cancelOperation: (ctx, id) => base.cancelOperation(ctx, id), detachAttachment: (ctx, input) => base.detachAttachment(ctx, input), releaseAllocation: (ctx, input) => base.releaseAllocation(ctx, input),
  };
  const hub = new Hub(join(directory, 'hub.sqlite'), { mode: 'external', connectors: { execution: { 'execution-sim': execution }, runtime: { 'runtime-sim-structured': simulator.runtimeFor('structured') } } });
  try {
    const actor = hub.actorForUser('user-admin'); assert.ok(actor);
    const task = await hub.execute(actor, { commandId: 'precreated-task', type: 'task.create', payload: { projectId: 'project-default', title: 'Use the provider-owned native session' } });
    const taskId = task.objectRefs[0]?.id; assert.ok(taskId);
    const delegated = await hub.execute(actor, { commandId: 'precreated-delegate', type: 'attempt.delegate', target: { kind: 'task', id: taskId }, expected: { task: 1, profile: 1 }, payload: { profileId: 'profile-structured', environment: { mode: 'provision', executionInstallationId: 'execution-sim', externalProfileRef: 'precreated-session', parameters: {}, releasePolicyRef: 'retain', workAreas: [] }, selectedReferenceIds: [], selectedResponseIds: [] } });
    assert.equal(delegated.status, 'accepted');
    await drainIdle(hub);
    const openCalls = simulator.calls.list().filter((call) => call.operationKind === 'runtime.openSession');
    assert.equal(openCalls.length, 1, JSON.stringify({ calls: simulator.calls.list().map((call) => call.operationKind), operations: hub.snapshot(actor).operations?.map((operation) => ({ kind: operation['operationKind'], status: operation['status'], receipt: operation['receiptJson'] })) }));
    assert.equal(openCalls[0]?.input['mode'], 'attach');
    assert.equal(openCalls[0]?.input['sessionLaunchOwner'], 'execution_provider');
    assert.equal(simulator.calls.list().filter((call) => call.operationKind === 'runtime.startAttempt').length, 1);
    const session = hub.snapshot(actor).sessions[0]; assert.ok(session?.nativeIdentityKey);
    assert.equal(z.object({ id: z.string() }).parse(JSON.parse(session.nativeIdentityKey)).id, nativeSession.id);
  } finally { hub.close(); simulator.close(); rmSync(directory, { recursive: true }); }
});
