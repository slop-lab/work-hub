import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvironmentAttachmentSchema } from '../application/contracts/index.ts';
import { attachmentHonorsSelection } from '../application/orchestration/environment-safety.ts';
import { writableArea } from './acceptance-fixture.ts';

test('attachment authority cannot include an area absent from the immutable selection', () => {
  const identity = { native: { installationId: 'provider', providerScope: 'scope', kind: 'environment', id: 'resource' }, assurance: 'immutable' } as const;
  const attachment = EnvironmentAttachmentSchema.parse({ hubBindingId: 'binding', hubBindingGeneration: 1,
    attachmentRef: { ...identity.native, kind: 'attachment' }, identity, origin: 'registered_existing', routes: [],
    useGrant: { id: 'grant', allowedWorkAreas: [writableArea, { ...writableArea, key: 'other', path: '/other' }],
      runtimeServiceLaunch: false, enforcement: 'enforced', exclusivity: 'external_enforced', limitations: [] } });
  assert.equal(attachmentHonorsSelection({ attachment, expectedIdentity: identity, requestedAccess: 'write',
    workAreas: [writableArea], now: '2026-10-25T08:00:00Z' }), false);
});
