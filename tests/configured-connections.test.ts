import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfiguredConnections } from '../application/connectors/configured.ts';
import { readPrivateConfiguration } from '../application/connectors/private-config.ts';
import { admin, member } from './acceptance-fixture.ts';
import { openCodeFixture } from './opencode-fixture.ts';

test('configured discovery projects only safe metadata and requires administrator authority', async () => {
  const fixture = await openCodeFixture();
  const root = mkdtempSync(join(tmpdir(), 'workhub-config-'));
  const path = join(root, 'connections.json');
  writeFileSync(path, JSON.stringify({ opencode: [fixture.connection] }), { mode: 0o600 });
  const connections = new ConfiguredConnections(path, join(root, 'connectors.sqlite'));
  try {
    const inventory = await connections.discover(admin);
    assert.equal(inventory.runtime[0]?.status, 'available');
    assert.equal(JSON.stringify(inventory).includes(fixture.connection.authorization), false);
    assert.equal(JSON.stringify(inventory).includes(fixture.connection.origin), false);
    await assert.rejects(connections.discover(member), /administrator/i);
    assert.equal(fixture.calls.some((call) => call.method === 'POST'), false);
  } finally { await connections.close(); await fixture.close(); rmSync(root, { recursive: true }); }
});

test('connection files with browser-readable permissions are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'workhub-private-config-'));
  const path = join(root, 'connections.json');
  writeFileSync(path, '{}', { mode: 0o600 });
  chmodSync(path, 0o644);
  try { assert.throws(() => readPrivateConfiguration(path), /private 0600/); }
  finally { rmSync(root, { recursive: true }); }
});

test('recipient integration configuration keeps Work Hub and target workspace identities distinct and private', async () => {
  const runtime = await openCodeFixture();
  const root = mkdtempSync(join(tmpdir(), 'workhub-recipient-config-'));
  const path = join(root, 'connections.json');
  const authorization = 'Bearer private-recipient-credential';
  const environment = { executionInstallationId: 'execution-one', hostId: 'host-one',
    workspaceId: '11111111-1111-4111-8111-111111111111', incarnation: 'container:one' };
  writeFileSync(path, JSON.stringify({ opencode: [{ ...runtime.connection,
    installationId: 'runtime-one', environment }], recipientIntegrations: [{ installationId: 'runtime-one',
    hostId: 'host-one', workHubWorkspaceId: 'workspace-default',
    targetWorkspaceId: '11111111-1111-4111-8111-111111111111',
    incarnation: 'container:one', authorization }] }), { mode: 0o600 });
  const connections = new ConfiguredConnections(path, join(root, 'connectors.sqlite'));
  try {
    assert.equal(connections.recipientIntegrations[0]?.workHubWorkspaceId, 'workspace-default');
    assert.equal(connections.recipientIntegrations[0]?.targetWorkspaceId,
      '11111111-1111-4111-8111-111111111111');
    assert.equal(JSON.stringify(await connections.discover(admin)).includes(authorization), false);
  } finally {
    await connections.close();
    await runtime.close();
    rmSync(root, { recursive: true });
  }
});
