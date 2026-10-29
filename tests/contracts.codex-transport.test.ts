import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexAppServerProtocol, CodexProtocolError } from '../application/connectors/codex/protocol.ts';

const fixture = fileURLToPath(new URL('./contracts.codex-wire.fixture.mjs', import.meta.url));
const brokenStdinFixture = fileURLToPath(new URL('./contracts.codex-broken-stdin.fixture.mjs', import.meta.url));

async function protocol(executable: string) {
  const root = await mkdtemp(join(tmpdir(), 'workhub-codex-transport-'));
  if (!executable.startsWith('/definitely-missing/')) await chmod(executable, 0o755);
  return { root, client: new CodexAppServerProtocol({ kind: 'codex', installationId: 'transport', label: 'Transport fixture',
    executable, directory: root, codexHome: root, modelProvider: 'openai', model: 'fixture', runtimePath: process.env['PATH'] ?? '/usr/bin' }) };
}
async function cleanup(setup: Awaited<ReturnType<typeof protocol>>): Promise<void> {
  await setup.client.close().catch(() => undefined);
  await rm(setup.root, { recursive: true, force: true });
}

test('missing Codex executable rejects with a sanitized transport error without an unhandled child error', async () => {
  const setup = await protocol('/definitely-missing/codex');
  try {
    await assert.rejects(setup.client.request('model/list', {}), /could not be started/);
  } finally { await cleanup(setup); }
});

test('closed Codex stdin rejects the request without an unhandled stream error', async () => {
  const setup = await protocol(brokenStdinFixture);
  try {
    await assert.rejects(setup.client.request('model/list', {}), /transport is unavailable/);
  } finally { await cleanup(setup); }
});

test('oversized Codex stdout line is rejected before unbounded buffering', async () => {
  const setup = await protocol(fixture);
  try {
    await assert.rejects(setup.client.request('test/oversized-line', {}), /line exceeded/);
  } finally { await cleanup(setup); }
});

test('Codex notification retention remains bounded during a provider flood', async () => {
  const setup = await protocol(fixture);
  try {
    await setup.client.request('test/notifications', {});
    const events = setup.client.drainEvents('thread-1');
    assert.ok(events.length <= 256);
    assert.equal(events.at(-1)?.method, 'test/event');
  } finally { await cleanup(setup); }
});

test('Codex transport retains exact retry and rate-limit notifications for lifecycle mapping', async () => {
  const setup = await protocol(fixture);
  try {
    await setup.client.request('test/lifecycle-notifications', { threadId: 'thread-1', turnId: 'turn-1' });
    const events = setup.client.drainEvents('thread-1');
    assert.deepEqual(events.map((event) => event.method), ['error', 'account/rateLimits/updated']);
    assert.deepEqual(events[0]?.params, { threadId: 'thread-1', turnId: 'turn-1', willRetry: true,
      error: { message: 'retry', codexErrorInfo: 'serverOverloaded', additionalDetails: null, misalignment: null } });
  } finally { await cleanup(setup); }
});

test('Codex transport answers a supported server request with its exact JSON-RPC id', async () => {
  const setup = await protocol(fixture);
  try {
    const result = setup.client.request('test/server-question', { threadId: 'thread-1', turnId: 'turn-1' });
    let request = setup.client.pendingServerRequests()[0];
    for (let index = 0; request === undefined && index < 20; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      request = setup.client.pendingServerRequests()[0];
    }
    assert.equal(request?.method, 'item/tool/requestUserInput');
    assert.ok(request?.nativeRequestId);
    await setup.client.respondServerRequest(request.nativeRequestId, { answers: { 'question-1': { answers: ['Alpha'] } } });
    assert.deepEqual(await result, { answers: { 'question-1': { answers: ['Alpha'] } } });
  } finally { await cleanup(setup); }
});

test('Codex transport reconnects after app-server exit without replaying the failed request', async () => {
  const setup = await protocol(fixture);
  try {
    await assert.rejects(setup.client.request('test/exit', {}), /exited/);
    assert.deepEqual(await setup.client.request('model/list', {}), { data: [], nextCursor: null });
  } finally { await cleanup(setup); }
});

test('Codex protocol errors preserve the numeric code but never expose provider text', async () => {
  const setup = await protocol(fixture);
  try {
    const error = await setup.client.request('test/provider-error', {}).then(() => undefined, (reason: unknown) => reason);
    assert.ok(error instanceof CodexProtocolError);
    assert.equal(error.code, 4321);
    assert.equal(error.message.includes('private-upstream-provider-detail'), false);
  } finally { await cleanup(setup); }
});
