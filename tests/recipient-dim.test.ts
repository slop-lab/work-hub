import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createDimRecipientPlugin, createWorkHubRecipientProxy, type RecipientRegistration } from '../application/integrations/dim-recipient.ts';
import { HubError } from '../application/domain/errors.ts';

const registered: RecipientRegistration = { installationId: 'runtime-one', hostId: 'host-one',
  workHubWorkspaceId: 'workspace-default', targetWorkspaceId: '11111111-1111-4111-8111-111111111111', incarnation: 'container:original', port: 4096,
  origin: 'https://hub.example/', authorization: 'Bearer synthetic-private-integration' };
const context = { stateRoot: '/private/operator', signal: new AbortController().signal,
  runtime: { resolveTarget: async () => ({ fingerprint: 'container:original' }) } };

test('DIM recipient integration derives UUID scope from the SDK caller and never returns its private credential', async () => {
  const plugin = createDimRecipientPlugin(async (target, nativeSessionId) => ({ installationId: target.installationId, nativeSessionId }), () => [registered]);
  const assignment = plugin.guest.operations.find((item) => item.name === 'assignment');
  assert.ok(assignment);
  const result = await assignment.handle({ nativeSessionId: 'ses_disposable' }, { id: registered.targetWorkspaceId, phase: 'running' }, context);
  assert.deepEqual(result, { installationId: 'runtime-one', nativeSessionId: 'ses_disposable' });
  assert.equal(JSON.stringify(result).includes(registered.authorization), false);
  await assert.rejects(assignment.handle({ nativeSessionId: 'ses_disposable' },
    { id: '22222222-2222-4222-8222-222222222222', phase: 'running' }, context),
    (error: unknown) => error instanceof HubError && error.data.code === 'recipient_unconfigured');
});

test('DIM recipient integration rejects a same-UUID recreated runtime before any capability exchange', async () => {
  let exchanged = false;
  const plugin = createDimRecipientPlugin(async () => { exchanged = true; return {}; }, () => [registered]);
  const assignment = plugin.guest.operations.find((item) => item.name === 'assignment');
  assert.ok(assignment);
  await assert.rejects(assignment.handle({ nativeSessionId: 'ses_disposable' }, { id: registered.targetWorkspaceId, phase: 'running' },
    { ...context, runtime: { resolveTarget: async () => ({ fingerprint: 'container:replacement' }) } }),
    (error: unknown) => error instanceof HubError && error.data.category === 'identity_mismatch');
  assert.equal(exchanged, false);
});

test('DIM recipient integration refuses stopped or unattestable targets instead of advertising readiness', async () => {
  const plugin = createDimRecipientPlugin(async () => ({}), () => [registered]);
  const assignment = plugin.guest.operations.find((item) => item.name === 'assignment');
  assert.ok(assignment);
  await assert.rejects(assignment.handle({ nativeSessionId: 'ses_disposable' }, { id: registered.targetWorkspaceId, phase: 'stopped' }, context));
  const facts = await plugin.workspaceCapabilities({ id: registered.targetWorkspaceId, phase: 'running' },
    { stateRoot: '/private/operator', signal: new AbortController().signal });
  assert.ok(facts.every((fact) => fact.state !== 'available'));
});

test('DIM recipient proxy keeps integration and bridge tokens inside trusted transport while forwarding exact ack and result', async () => {
  const requests: { readonly path: string; readonly authorization: string; readonly body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: request.url ?? '', authorization: request.headers.authorization ?? '', body });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/recipient/exchange') {
      response.end(JSON.stringify({ token: 'short-lived-bridge', expiresAt: '2099-01-01T00:00:00.000Z', assignment: {
        workHubWorkspaceId: registered.workHubWorkspaceId, targetWorkspaceId: registered.targetWorkspaceId,
        hostId: registered.hostId, projectId: 'project-default', taskId: 'task-one', sessionId: 'session-one',
        sessionRevision: 1, attemptId: 'attempt-one', bindingGeneration: 1, installationId: registered.installationId,
        incarnation: registered.incarnation, nativeSessionDigest: 'sha256:native', deliveryDigest: 'sha256:delivery',
        profileId: 'profile-one', profileRevision: 1, inputSnapshot: { digest: 'sha256:input' },
      } })); return;
    }
    response.end(JSON.stringify({ status: 'confirmed' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Fixture address missing');
  const registration = { ...registered, origin: `http://127.0.0.1:${address.port}/` };
  try {
    const proxy = createWorkHubRecipientProxy();
    const assignment = await proxy(registration, 'ses_disposable', { kind: 'assignment' });
    assert.equal(JSON.stringify(assignment).includes('short-lived-bridge'), false);
    await proxy(registration, 'ses_disposable', { kind: 'ack', deliveryDigest: 'sha256:delivery' });
    await proxy(registration, 'ses_disposable', { kind: 'result', result: { submissionKey: 'native-ubuntu',
      kind: 'final', sourceCommit: 'a'.repeat(40), contextDigest: 'sha256:context',
      outcome: 'partial', summary: 'Native checks retained.',
      limitations: ['One blocker'], referenceIds: [], artifacts: [{ repositoryId: 'repo-one', sourceCommit: 'a'.repeat(40), path: 'docs/report.md' }],
      criterionEvidence: [],
      evidence: [{ origin: 'agent_claim', detail: 'Agent-reported native evidence.' }] } });
    assert.equal(requests.filter((item) => item.path === '/api/v1/recipient/exchange').length, 3);
    assert.ok(requests.filter((item) => item.path !== '/api/v1/recipient/exchange').every((item) => item.authorization === 'Bearer short-lived-bridge'));
    assert.ok(requests.every((item) => !JSON.stringify(item.body).includes(registration.authorization)));
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
