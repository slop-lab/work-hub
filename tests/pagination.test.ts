import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CursorError, paginate } from '../application/orchestration/pagination.ts';

test('keyset pagination stays query-scoped and does not duplicate an inserted earlier item', () => {
  const base = { items: ['b', 'c', 'd'], key: (value: string) => value, query: 'project=one', snapshot: '14', limit: 2 };
  const first = paginate(base);
  assert.deepEqual(first.items, ['b', 'c']);
  assert.ok(first.nextCursor);
  const second = paginate({ ...base, items: ['a', 'b', 'c', 'd'], snapshot: '15', cursor: first.nextCursor });
  assert.deepEqual(second.items, ['d']);
  assert.equal(second.snapshotCursor, '14');
  assert.throws(() => paginate({ ...base, query: 'project=two', cursor: first.nextCursor ?? '' }), CursorError);
});

test('malformed pagination cursors fail closed', () => {
  assert.throws(() => paginate({ items: [], key: String, query: '', snapshot: '0', limit: 20, cursor: 'not-valid-json' }), CursorError);
});
