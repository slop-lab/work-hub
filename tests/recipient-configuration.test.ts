import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfiguredConnections } from '../application/connectors/configured.ts';
import { HubError } from '../application/domain/errors.ts';

const target = { executionInstallationId: 'dim-target', hostId: 'remote-main-4',
  workspaceId: '11111111-1111-4111-8111-111111111111', incarnation: 'container:exact' };

test('recipient integration must match the configured runtime host workspace UUID and incarnation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workhub-recipient-config-'));
  const path = join(root, 'connections.json');
  const value = (workspaceId: string) => ({ opencode: [{ installationId: 'opencode-target', label: 'Verifier',
    origin: 'http://127.0.0.1:4096/', authorization: 'Basic synthetic', directory: root,
    recipient: { hostId: target.hostId, workspaceId: target.workspaceId, incarnation: target.incarnation } }],
    recipientIntegrations: [{ installationId: 'opencode-target',
    hostId: target.hostId, workHubWorkspaceId: 'workspace-default', targetWorkspaceId: workspaceId,
    incarnation: target.incarnation, authorization: 'synthetic-integration-secret' }] });
  try {
    writeFileSync(path, JSON.stringify(value(target.workspaceId)), { mode: 0o600 });
    const configured = new ConfiguredConnections(path, join(root, 'valid.sqlite'));
    await configured.close();
    writeFileSync(path, JSON.stringify(value('22222222-2222-4222-8222-222222222222')), { mode: 0o600 });
    assert.throws(() => new ConfiguredConnections(path, join(root, 'invalid.sqlite')),
      (error: unknown) => error instanceof HubError && error.data.code === 'recipient_runtime_mapping');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
