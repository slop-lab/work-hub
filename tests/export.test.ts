import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportSafeRecords } from '../application/artifacts/export.ts';

test('exports remove private route handles even inside serialized provider receipts', () => {
  const result = exportSafeRecords({ tasks: [{ id: 'task-one', title: 'Keep this human intent' }], operations: [{ id: 'operation-one', receiptJson: JSON.stringify({ status: 'confirmed', result: { nativeSession: { id: 'native-one' }, route: { id: 'private-route-handle' }, routes: [{ id: 'another-private-route' }] } }) }], environments: [{ locator: { host: 'private-host' }, verifiedIdentity: { native: { id: 'environment-one' } } }] });
  const exported = JSON.stringify(result);
  assert.equal(exported.includes('private-route'), false);
  assert.equal(exported.includes('private-host'), false);
  assert.equal(exported.includes('task-one'), true);
  assert.equal(exported.includes('native-one'), true);
  assert.equal(exported.includes('environment-one'), true);
});
