import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConnectorReceipt } from '../application/orchestration/connector-receipt.ts';

test('connector boundary refuses a valid receipt associated with a different operation', () => {
  const context = { workspaceId: 'w', installationId: 'i', correlationId: 'c', commandId: 'c',
    operationId: 'expected', inputDigest: 'sha256:abc', authorizedGrantRefs: [] };
  const receipt = { operationId: 'other', operationKind: 'execution.detachAttachment',
    resultSchemaId: 'workhub.execution.detached.v1', updatedAt: '2026-10-25T08:00:00Z', partialEffects: [],
    status: 'confirmed', result: { detached: true },
    evidence: { effect: 'binding.detached', source: 'provider_receipt', observedAt: '2026-10-25T08:00:00Z' } } as const;
  assert.throws(() => validateConnectorReceipt({ context, receipt, operationKind: 'execution.detachAttachment' }));
  assert.throws(() => validateConnectorReceipt({ context, receipt: { ...receipt, operationId: 'expected',
    evidence: { ...receipt.evidence, effect: 'allocation.release_policy_applied' } }, operationKind: 'execution.detachAttachment' }));
  assert.equal(validateConnectorReceipt({ context, receipt: { ...receipt, operationId: 'expected' },
    operationKind: 'execution.detachAttachment' }).status, 'confirmed');
});
