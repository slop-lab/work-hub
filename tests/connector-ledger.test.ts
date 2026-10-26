import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ConnectorLedger } from '../application/connectors/ledger.ts';

const ctx = { workspaceId: 'hub', installationId: 'native', correlationId: 'c',
  commandId: 'c', operationId: 'op', inputDigest: 'sha256:123', authorizedGrantRefs: [] };
const spec = { kind: 'runtime.startAttempt', schemaId: 'workhub.runtime.input-receipt.v1',
  schema: z.object({ acceptance: z.literal('received') }), input: { text: 'work' }, effect: 'attempt.input_received' };

test('uncertain delivery is never replayed after restart', async () => {
  // Given: an effect reached the provider but its acknowledgment was lost.
  const root = mkdtempSync(join(tmpdir(), 'workhub-ledger-'));
  const path = join(root, 'connector.sqlite');
  let calls = 0;
  const first = new ConnectorLedger(path);
  await first.execute(ctx, spec, async () => { calls++; throw new Error('private provider output'); });
  first.close();
  const resumed = new ConnectorLedger(path);
  try {
    // When: the caller retries the persisted operation after restart.
    const receipt = await resumed.execute(ctx, spec, async () => { calls++; return { acceptance: 'received' }; });
    // Then: uncertainty survives without replay or raw provider output.
    assert.equal(calls, 1);
    assert.equal(receipt.status, 'unknown');
    assert.equal(JSON.stringify(receipt).includes('private provider output'), false);
    assert.equal(resumed.lookup(ctx, 'op').kind, 'found');
  } finally { resumed.close(); rmSync(root, { recursive: true }); }
});

test('operation identity cannot be reused for changed input', async () => {
  // Given: a previously confirmed operation.
  const ledger = new ConnectorLedger(':memory:');
  try {
    await ledger.execute(ctx, spec, async () => ({ acceptance: 'received' }));
    // When: the same operation ID is used with changed semantic input.
    const action = ledger.execute(ctx, { ...spec, input: { text: 'different' } }, async () => ({ acceptance: 'received' }));
    // Then: it is rejected, even if the caller incorrectly reuses its digest.
    await assert.rejects(action, { name: 'HubError' });
  } finally { ledger.close(); }
});
