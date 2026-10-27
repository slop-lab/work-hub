import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CodexAppServerProtocol } from '../application/connectors/codex/protocol.ts';

const stateSchema = z.object({ methods: z.array(z.string()), environmentKeys: z.array(z.string()), cwd: z.string(), codexHome: z.string(),
  threadReadCount: z.number() });
const threadId = '01900000-0000-7000-8000-000000000001';

async function pendingWithin(operation: Promise<void>): Promise<boolean> {
  return Promise.race([operation.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50))]);
}

test('Codex stdio driver performs initialize handshake and exposes only explicit child environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workhub-codex-wire-'));
  const fixture = fileURLToPath(new URL('./contracts.codex-wire.fixture.mjs', import.meta.url));
  await chmod(fixture, 0o755);
  const previousDim = process.env['DIM_MASTER_SECRET'];
  const previousOpenCode = process.env['OPENCODE_TOKEN'];
  process.env['DIM_MASTER_SECRET'] = 'must-not-cross';
  process.env['OPENCODE_TOKEN'] = 'must-not-cross';
  const protocol = new CodexAppServerProtocol({ kind: 'codex', installationId: 'wire', label: 'Wire fixture', executable: fixture,
    directory: root, codexHome: join(root, 'home'), modelProvider: 'openai', model: 'fixture', runtimePath: process.env['PATH'] ?? '/usr/bin' });
  try {
    assert.equal(await protocol.version(), '0.164.0');
    await protocol.request('model/list', {});
    const state = stateSchema.parse(await protocol.request('test/state', {}));
    assert.deepEqual(state.methods.slice(0, 3), ['initialize', 'initialized', 'model/list']);
    assert.equal(state.cwd, root);
    assert.equal(state.codexHome, join(root, 'home'));
    assert.equal(state.environmentKeys.includes('DIM_MASTER_SECRET'), false);
    assert.equal(state.environmentKeys.includes('OPENCODE_TOKEN'), false);
  } finally {
    await protocol.close();
    if (previousDim === undefined) delete process.env['DIM_MASTER_SECRET']; else process.env['DIM_MASTER_SECRET'] = previousDim;
    if (previousOpenCode === undefined) delete process.env['OPENCODE_TOKEN']; else process.env['OPENCODE_TOKEN'] = previousOpenCode;
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex close rejects new requests and does not signal an accepted turn before it becomes terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workhub-codex-close-'));
  const fixture = fileURLToPath(new URL('./contracts.codex-wire.fixture.mjs', import.meta.url));
  await chmod(fixture, 0o755);
  const protocol = new CodexAppServerProtocol({ kind: 'codex', installationId: 'wire', label: 'Wire fixture', executable: fixture,
    directory: root, codexHome: root, modelProvider: 'openai', model: 'fixture', runtimePath: process.env['PATH'] ?? '/usr/bin' });
  try {
    protocol.trackSubmission(threadId, 'workhub:accepted');
    const response = z.object({ turn: z.object({ id: z.string() }) }).parse(await protocol.request('turn/start', {
      threadId, clientUserMessageId: 'workhub:accepted', input: [{ type: 'text', text: 'accepted', text_elements: [] }],
    }));
    protocol.trackAcceptedTurn(threadId, 'workhub:accepted', response.turn.id);
    const closing = protocol.close();
    await assert.rejects(protocol.request('model/list', {}), /closing/);
    assert.equal(await pendingWithin(closing), true);
    await assert.rejects(readFile(join(root, 'sigterm-observed')), /ENOENT/);
    await writeFile(join(root, 'complete-turns'), 'yes');
    await closing;
    assert.equal(await readFile(join(root, 'sigterm-observed'), 'utf8'), 'yes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex close reconciles an unknown submission by exact client id and waits for its native turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workhub-codex-unknown-close-'));
  const fixture = fileURLToPath(new URL('./contracts.codex-wire.fixture.mjs', import.meta.url));
  await chmod(fixture, 0o755);
  const protocol = new CodexAppServerProtocol({ kind: 'codex', installationId: 'wire', label: 'Wire fixture', executable: fixture,
    directory: root, codexHome: root, modelProvider: 'openai', model: 'fixture', runtimePath: process.env['PATH'] ?? '/usr/bin' });
  try {
    protocol.trackSubmission(threadId, 'workhub:unknown');
    await protocol.request('test/add-unknown-turn', { clientId: 'workhub:unknown' });
    const closing = protocol.close();
    assert.equal(await pendingWithin(closing), true);
    await assert.rejects(readFile(join(root, 'sigterm-observed')), /ENOENT/);
    await writeFile(join(root, 'complete-turns'), 'yes');
    await closing;
    assert.equal(await readFile(join(root, 'sigterm-observed'), 'utf8'), 'yes');
  } finally { await rm(root, { recursive: true, force: true }); }
});
