import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfiguredConnections } from '../application/connectors/configured.ts';
import { CodexRuntimeConnector } from '../application/connectors/codex/runtime.ts';
import { ClaudeCodeRuntimeConnector } from '../application/connectors/claude/runtime.ts';
import { z } from 'zod';
import { setImmediate } from 'node:timers/promises';

test('a private configuration registers Codex and Claude independently without an OpenCode fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-runtime-config-'));
  const path = join(root, 'connections.json');
  writeFileSync(path, JSON.stringify({
    codex: [{ kind: 'codex', installationId: 'codex-local', label: 'Codex', executable: process.execPath,
      directory: root, codexHome: root, modelProvider: 'provider', model: 'selected-model' }],
    claude: [{ kind: 'claude-code', installationId: 'claude-local', label: 'Claude Code', directory: root }],
  }), { mode: 0o600 });
  try {
    const connections = new ConfiguredConnections(path, join(root, 'ledger.sqlite'));
    try {
      assert.deepEqual(Object.keys(connections.runtime).sort(), ['claude-local', 'codex-local']);
      assert.equal(connections.runtime['codex-local']?.describe().manifest.kind, 'agent_runtime');
      assert.equal(connections.runtime['claude-local']?.describe().capabilities.createSession.support, 'unsupported');
      assert.equal(connections.runtime['runtime-sim-structured'], undefined);
    } finally { await connections.close(); }
  } finally { rmSync(root, { recursive: true }); }
});

test('shutdown waits for all runtimes and closes its ledger even when one runtime rejects', async () => {
  // Given two independently closing runtimes, one of which fails.
  const root = mkdtempSync(join(tmpdir(), 'work-hub-shutdown-'));
  const path = join(root, 'connections.json');
  writeFileSync(path, JSON.stringify({
    codex: [{ kind: 'codex', installationId: 'codex-local', label: 'Codex', executable: process.execPath,
      directory: root, codexHome: root, modelProvider: 'provider', model: 'selected-model' }],
    claude: [{ kind: 'claude-code', installationId: 'claude-local', label: 'Claude', directory: root }],
  }), { mode: 0o600 });
  const connections = new ConfiguredConnections(path, join(root, 'ledger.sqlite'));
  const codex = connections.runtime['codex-local'];
  const claude = connections.runtime['claude-local'];
  assert.ok(codex instanceof CodexRuntimeConnector);
  assert.ok(claude instanceof ClaudeCodeRuntimeConnector);
  let drained = false;
  const failure = new Error('Runtime close failed');
  codex.close = async () => { throw failure; };
  claude.close = async () => { await setImmediate(); drained = true; };
  try {
    // When shutdown encounters a failure while another runtime is draining.
    const closing = connections.close();
    const rejected = assert.rejects(closing, (error: unknown) => error instanceof AggregateError && error.errors.includes(failure));
    await Promise.resolve();
    assert.equal(codex.state.ledger.get('still-draining', z.string()), undefined);
    await rejected;
    assert.equal(drained, true);
    // Then cleanup preserves the failure and closes the ledger after draining.
    assert.throws(() => codex.state.ledger.get('after-close', z.string()), /not open|closed/i);
  } finally { rmSync(root, { recursive: true }); }
});
