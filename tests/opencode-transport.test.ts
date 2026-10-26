import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { OpenCodeClient } from '../application/connectors/opencode/client.ts';
import { HubError } from '../application/domain/errors.ts';

const context = { workspaceId: 'transport-test', installationId: 'disposable', correlationId: 'read' };
type Outcome = { readonly kind: 'resolved'; readonly value: unknown } |
  { readonly kind: 'rejected'; readonly error: unknown } | { readonly kind: 'pending' };

async function settleWithin(operation: Promise<unknown>, milliseconds: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then((value): Outcome => ({ kind: 'resolved', value }),
        (error: unknown): Outcome => ({ kind: 'rejected', error })),
      new Promise<Outcome>((resolve) => { timer = setTimeout(() => resolve({ kind: 'pending' }), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function stalledBodyFixture() {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
  });
  const headers = once(server, 'request');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { headers, requests: () => requests, client: new OpenCodeClient({ installationId: 'disposable', label: 'Stalled body fixture',
    origin: `http://127.0.0.1:${address.port}`, directory: '/fixture', authorization: 'Bearer fixture-only' }),
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

test('the ten-second OpenCode operation deadline includes a never-ending HTTP 200 JSON body', { timeout: 15_000 }, async () => {
  const fixture = await stalledBodyFixture();
  try {
    const started = performance.now();
    const operation = fixture.client.request(context, '/stalled');
    await fixture.headers;
    const outcome = await settleWithin(operation, 12_000);
    assert.equal(outcome.kind, 'rejected', 'The whole request must settle despite an unfinished body.');
    assert.ok(outcome.kind === 'rejected' && outcome.error instanceof HubError);
    assert.equal(outcome.error.data.code, 'opencode_timeout');
    assert.equal(outcome.error.data.retry, 'read_only_retry');
    assert.ok(performance.now() - started >= 9500, 'The existing ten-second budget must not be shortened.');
  } finally { await fixture.close(); }
});

test('caller cancellation settles a stalled body without leaking its reason or replaying a mutation', async () => {
  const fixture = await stalledBodyFixture();
  const caller = new AbortController();
  try {
    const operation = fixture.client.request({ ...context, signal: caller.signal }, '/stalled', { instruction: 'fixture-only' });
    await fixture.headers;
    caller.abort(new Error('private-cancellation-reason'));
    const outcome = await settleWithin(operation, 1000);
    assert.equal(outcome.kind, 'rejected');
    assert.ok(outcome.kind === 'rejected' && outcome.error instanceof HubError);
    assert.equal(outcome.error.data.code, 'opencode_cancelled');
    assert.equal(outcome.error.data.retry, 'reconcile_first');
    assert.equal(JSON.stringify(outcome.error.data).includes('private-cancellation-reason'), false);
    assert.equal(fixture.requests(), 1);
  } finally { await fixture.close(); }
});

test('an oversized body fails without awaiting a stalled stream cancellation', async (t) => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; return new Promise<void>(() => undefined); },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: { 'content-type': 'application/json' } }));
  const client = new OpenCodeClient({ installationId: 'disposable', label: 'Stalled cancellation fixture',
    origin: 'http://127.0.0.1', directory: '/fixture', authorization: 'Bearer fixture-only' });
  const outcome = await settleWithin(client.request(context, '/oversized'), 1000);
  assert.equal(outcome.kind, 'rejected');
  assert.ok(outcome.kind === 'rejected' && outcome.error instanceof HubError);
  assert.equal(outcome.error.data.code, 'opencode_response_limit');
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('successful async acceptance does not abort native work or retain a caller cancellation link', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let transportSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL) => {
    assert.ok(request instanceof Request);
    transportSignal = request.signal;
    return new Response(null, { status: 204 });
  });
  const caller = new AbortController();
  const client = new OpenCodeClient({ installationId: 'disposable', label: 'Accepted async fixture',
    origin: 'http://127.0.0.1', directory: '/fixture', authorization: 'Bearer fixture-only' });
  assert.equal(await client.request({ ...context, signal: caller.signal }, '/prompt_async', { instruction: 'fixture-only' }), null);
  assert.ok(transportSignal);
  assert.equal(transportSignal.aborted, false);
  caller.abort();
  t.mock.timers.tick(10_001);
  assert.equal(transportSignal.aborted, false);
});
