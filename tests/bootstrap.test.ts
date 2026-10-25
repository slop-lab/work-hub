import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('local bootstrap provides help and refuses repeated initialization', () => {
  const root = mkdtempSync(join(tmpdir(), 'work-hub-bootstrap-'));
  const script = join(import.meta.dirname, '../application/api/bootstrap.ts');
  const options = { env: { ...process.env, DATA_DIR: root }, encoding: 'utf8' } as const;
  const help = execFileSync(process.execPath, [script, '--help'], options);
  assert.match(help, /DATA_DIR/);
  const first = execFileSync(process.execPath, [script], options);
  assert.match(first, /[A-Za-z0-9_-]{43}/);
  const second = spawnSync(process.execPath, [script], options);
  assert.equal(second.status, 1);
  const bad = spawnSync(process.execPath, [script, 'not-a-command'], options);
  assert.equal(bad.status, 1);
  rmSync(root, { recursive: true });
});
