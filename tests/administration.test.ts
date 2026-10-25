import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../application/persistence/database.ts';
import { Administration, adminCommandSchema } from '../application/administration/index.ts';
import type { Actor } from '../application/domain/authorization.ts';

const admin: Actor = { id: 'user-admin', workspaceId: 'workspace-default', role: 'administrator', projectIds: ['project-default'], profileIds: [], bindingIds: [] };

test('user permissions are durable and disabling a user invalidates actor lookup', () => {
  const store = new Store(':memory:');
  const service = new Administration(store);
  const input = { displayName: 'Reviewer', role: 'member', projectIds: ['project-default'], profileIds: ['profile-structured'], bindingIds: [], enabled: true } as const;
  const created = store.transaction(() => service.apply(admin, adminCommandSchema.parse({ commandId: 'user-create', type: 'user.create', payload: input })));
  assert.equal(service.users.actorForUser(created.id)?.role, 'member');
  store.transaction(() => service.apply(admin, adminCommandSchema.parse({ commandId: 'user-disable', type: 'user.disable', target: { kind: 'user', id: created.id }, payload: { expectedRevision: 1 } })));
  assert.equal(service.users.actorForUser(created.id), undefined);
  assert.equal(service.users.list(admin).find((item) => item.id === created.id)?.revision, 2);
  store.close();
});

test('members cannot register connector installations and incompatible providers never fall back to simulation', () => {
  const store = new Store(':memory:');
  const service = new Administration(store);
  const command = adminCommandSchema.parse({ commandId: 'incompatible', type: 'installation.create', payload: { id: 'other-provider', label: 'Future provider', kind: 'agent_runtime', contractMajor: 2, implementation: 'missing' } });
  assert.throws(() => service.apply({ ...admin, role: 'member' }, command));
  store.transaction(() => service.apply(admin, command));
  assert.equal(service.installations.usable(admin, 'other-provider'), false);
  assert.equal(service.installations.list(admin).find((item) => item.id === 'other-provider')?.reason, 'contract_major_mismatch');
  store.close();
});

test('profile updates create immutable revisions rather than rewriting running input defaults', () => {
  const store = new Store(':memory:');
  const service = new Administration(store);
  const command = adminCommandSchema.parse({ commandId: 'disable-profile', type: 'profile.update', target: { kind: 'profile', id: 'profile-structured' }, expected: { profile: 1 }, payload: { enabled: false } });
  const result = store.transaction(() => service.apply(admin, command));
  assert.equal(result.revision, 2);
  assert.equal(service.profiles.list(admin).find((item) => item.id === 'profile-structured')?.enabled, false);
  const historical = store.database.prepare('SELECT enabled FROM execution_profiles WHERE id=? AND revision=1').get('profile-structured');
  assert.equal(historical?.['enabled'], 1);
  assert.throws(() => service.apply(admin, command));
  store.close();
});

test('profile configuration refuses literal credential fields nested inside lists', () => {
  const store = new Store(':memory:');
  const service = new Administration(store);
  const command = adminCommandSchema.parse({ commandId: 'secret-config', type: 'profile.update', target: { kind: 'profile', id: 'profile-structured' }, expected: { profile: 1 }, payload: { configuration: { providers: [{ apiKey: 'not-for-storage' }] } } });
  assert.throws(() => store.transaction(() => service.apply(admin, command)));
  assert.equal(service.profiles.list(admin).find((item) => item.id === 'profile-structured')?.revision, 1);
  store.close();
});
