import { createHash } from 'node:crypto';
import { z } from 'zod';

const cursorSchema = z.strictObject({ query: z.string(), after: z.string(), snapshot: z.string() });
export class CursorError extends Error {}

export type PageQuery<T> = {
  readonly items: readonly T[];
  readonly key: (item: T) => string;
  readonly query: string;
  readonly snapshot: string;
  readonly limit: number;
  readonly cursor?: string;
};

export function paginate<T>(input: PageQuery<T>) {
  const query = createHash('sha256').update(input.query).digest('hex');
  let after = '';
  let snapshot = input.snapshot;
  if (input.cursor) {
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw new CursorError('Invalid pagination cursor.');
      throw error;
    }
    const cursor = cursorSchema.safeParse(decoded);
    if (!cursor.success || cursor.data.query !== query) throw new CursorError('This cursor belongs to a different query.');
    after = cursor.data.after;
    snapshot = cursor.data.snapshot;
  }
  const limit = Math.max(1, Math.min(100, input.limit));
  const ordered = input.items.filter((item) => input.key(item) > after).toSorted((a, b) => {
    const left = input.key(a);
    const right = input.key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const items = ordered.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: ordered.length > limit && last ? Buffer.from(JSON.stringify({ query, after: input.key(last), snapshot })).toString('base64url') : null,
    snapshotCursor: snapshot,
  };
}
