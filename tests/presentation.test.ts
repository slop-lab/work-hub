import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentState } from '../application/api/presentation.ts';
import { Administration } from '../application/administration/index.ts';
import { Store } from '../application/persistence/database.ts';
import type { Actor } from '../application/domain/authorization.ts';
import type { HubSnapshot } from '../application/domain/model.ts';
import { hubStateSchema } from '../web/state-schema.ts';

const actor: Actor = { id: 'user-admin', workspaceId: 'workspace-default', role: 'administrator', projectIds: [], profileIds: [], bindingIds: [] };
const empty: HubSnapshot = { tasks: [], requests: [], sessions: [], attempts: [], environmentRegistrations: [], environmentBindings: [], results: [], profiles: [], dashboard: { answerNeeded: [], approvalNeeded: [], deliveryProblems: [], activeAttempts: [], resultsToReview: [], operationalIssues: [], snapshotCursor: '0' } };

test('the server presentation is accepted by the actual browser state schema', () => {
  const store = new Store(':memory:');
  const administration = new Administration(store);
  const result = hubStateSchema.parse(presentState({ snapshot: empty, actor, administration }));
  assert.equal(result.me.role, 'admin');
  assert.equal(result.projects[0]?.id, 'project-default');
  assert.equal(result.simulator, true);
  store.close();
});

test('existing attachment never gains release authority and absent enforcement remains unknown', () => {
  const store = new Store(':memory:');
  const administration = new Administration(store);
  const snapshot: HubSnapshot = { ...empty, environmentBindings: [{ id: 'binding-one', workspaceId: 'workspace-default', sessionId: 'session-one', sourceKind: 'registration', workAreaKeys: ['area-one'], accessMode: 'read', generation: 1, state: 'attached', createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' }] };
  const result = hubStateSchema.parse(presentState({ snapshot, actor, administration }));
  assert.equal(result.environmentBindings[0]?.canRelease, false);
  assert.equal(result.environmentBindings[0]?.enforcement, 'unknown');
  store.close();
});
