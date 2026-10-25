import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimestampSchema, InputSnapshotSchema, SurfaceChannelSchema, SurfaceContextSchema } from '../application/contracts/index.ts';

test('contract timestamps reject non-UTC offsets', () => {
  assert.equal(TimestampSchema.safeParse('2026-10-25T10:00:00+02:00').success, false);
  assert.equal(TimestampSchema.safeParse('2026-10-25T08:00:00Z').success, true);
});

test('input snapshots require a namespaced digest', () => {
  const snapshot = { id: 's', digest: 'not-a-digest', taskId: 't', taskRevision: 1,
    profileId: 'p', profileRevision: 1, instruction: '', selectedReferenceIds: [],
    selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [], assembledAt: '2026-10-25T08:00:00Z' };
  assert.equal(InputSnapshotSchema.safeParse(snapshot).success, false);
  assert.equal(InputSnapshotSchema.safeParse({ ...snapshot, digest: 'sha256:abc' }).success, true);
});

test('surface channels reject replayable input and unscoped context fields', () => {
  const channel = { id: 'channel', kind: 'terminal', scopedBrowserEndpoint: '/surface/channel',
    expiresAt: '2026-10-25T08:00:00Z', allowedActions: ['read'], inputReplay: 'forbidden' };
  assert.equal(SurfaceChannelSchema.safeParse(channel).success, true);
  assert.equal(SurfaceChannelSchema.safeParse({ ...channel, inputReplay: 'allowed' }).success, false);
  assert.equal(SurfaceContextSchema.safeParse({ sessionId: 's', generation: 1, mode: 'view', availableCommandTypes: [], shell: true }).success, false);
});
