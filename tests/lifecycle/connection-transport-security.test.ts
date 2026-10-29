import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionSchema } from '../../application/connectors/opencode/schema.ts';
import { dimConnectionSchema } from '../../application/connectors/dim.ts';

test('remote runtime credentials require HTTPS while loopback development may use HTTP', () => {
  const openCode = { installationId: 'runtime', label: 'Runtime', directory: '/workspace', authorization: 'Basic synthetic' };
  assert.equal(connectionSchema.safeParse({ ...openCode, origin: 'http://remote.example/' }).success, false);
  assert.equal(connectionSchema.safeParse({ ...openCode, origin: 'http://127.0.0.1:4096/' }).success, true);
  assert.equal(connectionSchema.safeParse({ ...openCode, origin: 'https://remote.example/' }).success, true);

  const dim = { installationId: 'dim', label: 'DIM', token: 'synthetic', hostId: 'host',
    workspaceId: '11111111-1111-4111-8111-111111111111', incarnation: 'runtime:one', displayName: 'Target',
    identityExpiresAt: '2099-01-01T00:00:00.000Z', runtimeInstallationId: 'runtime',
    allowedProjectIds: ['project-default'], workAreas: [{ key: 'repo', path: '/workspace',
      pathNamespace: 'provider-guest-posix', requestedAccess: 'read', preparation: 'preserve_existing' }] };
  assert.equal(dimConnectionSchema.safeParse({ ...dim, endpoint: 'http://remote.example/' }).success, false);
  assert.equal(dimConnectionSchema.safeParse({ ...dim, endpoint: 'http://localhost:8080/' }).success, true);
  assert.equal(dimConnectionSchema.safeParse({ ...dim, endpoint: 'https://remote.example/' }).success, true);
});
