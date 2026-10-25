import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorRegistry } from '../application/orchestration/connectors.ts';
import { createSimulators } from '../application/simulator/index.ts';
import { Administration } from '../application/administration/index.ts';
import { Store } from '../application/persistence/database.ts';
import { admin } from './acceptance-fixture.ts';

test('installation availability follows configured modules rather than simulator identifiers', () => {
  const store = new Store(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'provider-registration-'));
  const simulators = createSimulators(join(root, 'hub'));
  try {
    const registry = new ConnectorRegistry({ execution: { 'custom-execution': simulators.execution }, runtime: {} });
    const administration = new Administration(store, { connectorAvailable: (kind, id) => registry.available(kind, id) });
    administration.installations.create(admin, { id: 'custom-execution', label: 'Configured provider', kind: 'execution', contractMajor: 1, implementation: 'configured' });
    assert.equal(administration.installations.usable(admin, 'custom-execution'), true);
    assert.equal(administration.installations.usable(admin, 'execution-sim'), false);
  } finally { simulators.close(); store.close(); rmSync(root, { recursive: true }); }
});
