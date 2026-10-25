import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSimulators } from '../application/simulator/index.ts';
import { runtimeBoundary } from '../application/orchestration/connector-boundary.ts';

test('attaching a native session cannot silently bind a different provider target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-binding-'));
  const simulators = createSimulators(join(root, 'hub'));
  try {
    const connector = simulators.runtimeFor('structured');
    const original = connector.openSession.bind(connector);
    connector.openSession = async (context, input) => {
      const receipt = await original(context, input);
      return receipt.status === 'confirmed' ? { ...receipt,
        result: { ...receipt.result, nativeSession: { ...receipt.result.nativeSession, id: 'other-native-session' } } } : receipt;
    };
    const boundary = runtimeBoundary(connector);
    await assert.rejects(() => boundary.openSession({ workspaceId: 'w', installationId: 'runtime',
      correlationId: 'c', commandId: 'c', operationId: 'open', inputDigest: 'sha256:input', authorizedGrantRefs: [] },
    { mode: 'attach', hubSessionId: 's', nativeSession: { installationId: 'runtime', providerScope: 'simulated', kind: 'session', id: 'selected' },
      route: { kind: 'external', route: { id: 'route', ownerInstallationId: 'runtime', kind: 'external' } },
      configuration: {}, requestedControl: 'observe', sessionLaunchOwner: 'external' }));
  } finally { simulators.close(); rmSync(root, { recursive: true }); }
});

test('connector mutation inputs reject undocumented fields before provider invocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-input-boundary-'));
  const simulators = createSimulators(join(root, 'hub'));
  try {
    const connector = runtimeBoundary(simulators.runtimeFor('structured'));
    const input = { target: { hubSessionId: 's', nativeSession: { installationId: 'runtime', providerScope: 'scope', kind: 'session', id: 'native' }, bindingGeneration: 1, controlGrantRef: 'grant', hubAttemptId: 'a' }, mode: 'stop_work', undocumentedControl: true } as const;
    await assert.rejects(() => connector.requestStop({ workspaceId: 'w', installationId: 'runtime', correlationId: 'c', commandId: 'c', operationId: 'stop', inputDigest: 'sha256:input', authorizedGrantRefs: [] }, input));
    assert.equal(simulators.calls.list().length, 0);
  } finally { simulators.close(); rmSync(root, { recursive: true }); }
});

test('runtime inspection cannot claim an observation from a different installation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-observation-boundary-'));
  const simulators = createSimulators(join(root, 'hub'));
  try {
    const connector = simulators.runtimeFor('structured');
    const original = connector.inspectSession.bind(connector);
    connector.inspectSession = async (context, target) => ({ ...await original(context, target), sourceInstallationId: 'other-provider' });
    await assert.rejects(() => runtimeBoundary(connector).inspectSession({ workspaceId: 'w', installationId: 'runtime', correlationId: 'c' },
      { hubSessionId: 's', nativeSession: { installationId: 'runtime', providerScope: 'scope', kind: 'session', id: 'native' }, bindingGeneration: 1, controlGrantRef: 'grant' }));
  } finally { simulators.close(); rmSync(root, { recursive: true }); }
});
