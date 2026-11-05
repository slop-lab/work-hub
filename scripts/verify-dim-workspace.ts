import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { z } from 'zod';

import { DimExecutionConnector, dimConnectionSchema } from '../application/connectors/dim.ts';
import { ConnectorLedger } from '../application/connectors/ledger.ts';
import { readPrivateConfiguration } from '../application/connectors/private-config.ts';
import { HubError } from '../application/domain/errors.ts';

// Explicit non-billable invocation only. No runtime launch or infrastructure mutation.
if (process.argv[2] !== '--read-only') {
  process.stderr.write('Usage: node scripts/verify-dim-workspace.ts --read-only\n');
  process.exitCode = 2;
} else {
  const config = z.object({ endpoint: z.url(), token: z.string().min(1), workspaceId: z.uuid() })
    .parse(readPrivateConfiguration(join(homedir(), '.config/dim/workspace.json')));
  const discovery = z.object({ delivery: z.literal('online'), observedAt: z.string(),
    host: z.object({ hostname: z.string() }), workspace: z.object({ id: z.uuid(), name: z.string() }),
    executionEnvironment: z.object({ runtimeStatus: z.literal('running') }),
  }).parse(JSON.parse(execFileSync('dim-workspace', ['discovery'], { encoding: 'utf8' })));
  assert.equal(config.workspaceId, discovery.workspace.id);
  const directory = realpathSync(process.cwd());
  const connection = dimConnectionSchema.parse({
    installationId: 'verification-dim-scoped', label: 'Disposable scoped DIM read verification',
    endpoint: config.endpoint, token: config.token, hostId: discovery.host.hostname,
    workspaceId: config.workspaceId, displayName: discovery.workspace.name,
    // A test-only label, never represented as an owner-attested runtime incarnation.
    incarnation: 'verification-only-unattested',
    identityExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    runtimeInstallationId: 'verification-local', allowedProjectIds: ['verification-only'],
    workAreas: [{ key: 'candidate', path: directory, pathNamespace: 'workspace-posix',
      requestedAccess: 'read', preparation: 'preserve_existing' }],
  });
  const ledger = new ConnectorLedger(':memory:');
  try {
    const connector = new DimExecutionConnector(ledger, connection, async () => realpathSync(process.cwd()));
    const context = { workspaceId: 'verification-only', installationId: connection.installationId,
      correlationId: 'verification-discovery' };
    const denied = new DimExecutionConnector(ledger, { ...connection, token: 'verification-invalid-token' },
      async () => realpathSync(process.cwd()));
    await assert.rejects(denied.discover(context), (error: unknown) =>
      error instanceof HubError && error.data.code === 'dim_connection_unavailable');
    const result = await connector.discover(context);
    assert.equal(result.workspaceId, discovery.workspace.id);
    assert.ok(result.plugins.some((plugin) => plugin.name === 'native-git'));
    assert.equal(result.allocate, false);
    assert.equal(result.release, false);
    process.stdout.write(`${JSON.stringify({
      actual: true, mode: 'read-only', observedAt: discovery.observedAt,
      workspaceId: result.workspaceId, resources: result.resources,
      pluginCount: result.plugins.length, scopedGateway: new URL(config.endpoint).pathname,
      localDirectoryChecked: true, ownerIncarnationAttested: false,
      invalidCredentialRejected: true, readOnlyRecovery: true,
      infrastructureWrites: 0, credentialOutput: false,
    })}\n`);
  } finally { ledger.close(); }
}
