import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeRuntimeConnector } from '../application/connectors/opencode/runtime.ts';
import type { EnvironmentAttachment, OpenSessionInput } from '../application/contracts/index.ts';
import { context, openCodeFixture, selection } from './opencode-fixture.ts';

async function mappedFixture() {
  const fixture = await openCodeFixture();
  const mapping = { executionInstallationId: 'dim', hostId: 'host-stable', workspaceId: 'workspace-uuid', incarnation: 'inc-one' };
  const connector = new OpenCodeRuntimeConnector(fixture.ledger, { ...fixture.connection, environment: mapping });
  const area = { key: 'repo', path: '/fixture', pathNamespace: 'dim-workspace-posix', requestedAccess: 'write', preparation: 'preserve_existing' } as const;
  const route = { id: 'scoped-runtime', ownerInstallationId: 'dim', kind: 'opencode-configured' };
  const attachment: EnvironmentAttachment = { hubBindingId: 'env-binding', hubBindingGeneration: 1,
    attachmentRef: { installationId: 'dim', providerScope: 'host-stable', kind: 'attachment', id: 'env-binding' },
    identity: { native: { installationId: 'dim', providerScope: 'host-stable', kind: 'dim-workspace', id: mapping.workspaceId,
      incarnation: mapping.incarnation }, assurance: 'attested' }, origin: 'registered_existing', routes: [route],
    useGrant: { id: 'use-grant', allowedWorkAreas: [area], runtimeServiceLaunch: false, enforcement: 'advisory',
      exclusivity: 'hub_only', expiresAt: new Date(Date.now() + 60_000).toISOString(), limitations: [] } };
  const input: OpenSessionInput = { hubSessionId: 'logical', mode: 'create', sessionLaunchOwner: 'runtime_connector',
    requestedControl: 'control', configuration: selection, route: { kind: 'environment', attachment, route } };
  const authorized = { ...context('open'), authorizedGrantRefs: ['use-grant', 'opencode:logical'] };
  return { ...fixture, connector, attachment, area, openInput: input, authorized };
}

test('mapped OpenCode opening requires the selected environment grant and exact route membership', async () => {
  const f = await mappedFixture();
  try {
    await assert.rejects(f.connector.openSession(context('ungranted'), f.openInput), /use grant is required/);
    const forged: OpenSessionInput = { ...f.openInput, route: { kind: 'environment', attachment: f.attachment,
      route: { id: 'forged', ownerInstallationId: 'dim', kind: 'opencode-configured' } } };
    await assert.rejects(f.connector.openSession(f.authorized, forged), /not mapped/);
    assert.equal(f.calls.some((call) => call.method === 'POST'), false);
  } finally { await f.close(); }
});

test('mapped OpenCode cannot bypass DIM authority using environment-free delegation', async () => {
  const f = await mappedFixture();
  try {
    await assert.rejects(f.connector.openSession(f.authorized, { ...f.openInput,
      route: { kind: 'external', route: { id: 'external', ownerInstallationId: 'opencode-test', kind: 'http' } } }), /requires its mapped DIM environment/);
  } finally { await f.close(); }
});

test('expired environment authority blocks input but permits a safety interrupt', async () => {
  const f = await mappedFixture();
  try {
    assert.equal((await f.connector.openSession(f.authorized, f.openInput)).status, 'confirmed');
    assert.equal((await f.connector.startAttempt(context('start'), { ...f.input, workAreas: [f.area] })).status, 'confirmed');
    const binding = f.connector.state.get(context('read'), 'logical');
    assert.ok(binding?.environmentGrant);
    f.connector.state.save(context('expire'), 'logical', { ...binding,
      environmentGrant: { ...binding.environmentGrant, expiresAt: new Date(0).toISOString() } });
    await assert.rejects(f.connector.sendInstruction(context('followup'), { target: f.target, text: 'More work', referenceIds: [], mode: 'runtime_queued' }), /expired/);
    const stop = await f.connector.requestStop(context('stop'), { target: f.target, mode: 'interrupt' });
    assert.ok(stop.status === 'confirmed');
    assert.equal(stop.result.effect, 'request_accepted');
    assert.equal(f.calls.filter((call) => call.path.endsWith('prompt_async')).length, 1);
  } finally { await f.close(); }
});
