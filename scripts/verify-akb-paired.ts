import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import ky from 'ky';

import { JsonValueSchema } from '../application/contracts/common.ts';
import { readPrivateConfiguration } from '../application/connectors/private-config.ts';
import { akbContextRequestSchema } from '../application/connectors/akb/schema.ts';

const outcomeSchema = z.strictObject({ status: z.number().int().min(200).max(599), body: JsonValueSchema });
const manifestSchema = z.strictObject({
  format: z.literal('workhub.akb-paired-verification.v1'),
  ownerContract: z.strictObject({ path: z.string().startsWith('/'), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) }),
  origin: z.url(), workspaceId: z.string().min(1),
  principals: z.strictObject({ reader: z.string().startsWith('/'), unmapped: z.string().startsWith('/'),
    denied: z.string().startsWith('/') }),
  documentsQuery: z.strictObject({ kind: z.enum(['page', 'knowledge']), query: z.string(),
    limit: z.number().int().min(1).max(100) }),
  contextRequest: akbContextRequestSchema,
  resultRetrievalPath: z.string(),
  expected: z.strictObject({ documents: outcomeSchema, context: outcomeSchema,
    unauthenticated: outcomeSchema, unmapped: outcomeSchema, denied: outcomeSchema,
    result: outcomeSchema }),
});

async function main(): Promise<void> {
  const [action, manifestPath] = process.argv.slice(2);
  if (action !== '--run' || manifestPath === undefined) {
    throw new TypeError('Usage: node scripts/verify-akb-paired.ts --run /absolute/private-owner-manifest.json');
  }
  const manifest = manifestSchema.parse(readPrivateConfiguration(manifestPath));
  const contract = readFileSync(manifest.ownerContract.path);
  assert.equal(createHash('sha256').update(contract).digest('hex'), manifest.ownerContract.sha256);
  const origin = new URL(manifest.origin);
  assert.ok(origin.protocol === 'https:' || origin.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));
  assert.ok(origin.username === '' && origin.password === '' && origin.pathname === '/' &&
    origin.search === '' && origin.hash === '', 'AKB verification origin must not contain credentials or a path.');
  const workspace = encodeURIComponent(manifest.workspaceId);
  const content = `/api/content/v1/workspaces/${workspace}`;
  const resultPrefix = `/api/knowledge/v1/workspaces/${workspace}/`;
  assert.ok(manifest.resultRetrievalPath.startsWith(resultPrefix));
  assert.ok(!manifest.resultRetrievalPath.includes('..') && !manifest.resultRetrievalPath.includes('?') &&
    !manifest.resultRetrievalPath.includes('#') && !manifest.resultRetrievalPath.includes('%'));
  for (const expected of [manifest.expected.documents, manifest.expected.context, manifest.expected.result]) {
    assert.equal(expected.status, 200);
  }
  for (const expected of [manifest.expected.unauthenticated, manifest.expected.unmapped, manifest.expected.denied]) {
    assert.ok([401, 403, 404].includes(expected.status));
  }
  const principal = (path: string): string => z.strictObject({ token: z.string().min(1) })
    .parse(readPrivateConfiguration(path)).token;
  const reader = principal(manifest.principals.reader);
  const unmapped = principal(manifest.principals.unmapped);
  const denied = principal(manifest.principals.denied);
  const outcomes: { name: string; status: number; responseDigest: string }[] = [];
  const execute = async (input: { readonly name: string; readonly path: string; readonly token: string;
    readonly method: 'GET' | 'POST'; readonly expected: z.infer<typeof outcomeSchema>;
    readonly context?: z.infer<typeof akbContextRequestSchema> }) => {
    const response = await ky(new URL(input.path, origin), { method: input.method,
      headers: { authorization: `Bearer ${input.token}`, accept: 'application/json' },
      ...(input.context === undefined ? {} : { json: input.context }),
      timeout: 10_000, signal: AbortSignal.timeout(10_000),
      retry: 0, redirect: 'error', throwHttpErrors: false });
    assert.equal(response.status, input.expected.status, `${input.name}: HTTP status differs from owner contract`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          assert.ok(size <= 2 * 1024 * 1024, 'AKB verification response exceeds its private evidence bound.');
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
    }
    const raw = Buffer.concat(chunks);
    let body: z.infer<typeof JsonValueSchema>;
    try { body = JsonValueSchema.parse(JSON.parse(raw.toString('utf8'))); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
      throw new TypeError(`${input.name}: AKB response is not compatible JSON.`);
    }
    if (!isDeepStrictEqual(body, input.expected.body)) {
      throw new TypeError(`${input.name}: response differs from owner-supplied DTO.`);
    }
    outcomes.push({ name: input.name, status: response.status,
      responseDigest: createHash('sha256').update(raw).digest('hex') });
  };
  const query = new URLSearchParams({ kind: manifest.documentsQuery.kind, query: manifest.documentsQuery.query,
    limit: String(manifest.documentsQuery.limit) });
  await execute({ name: 'documents', path: `${content}/documents?${query}`, token: reader,
    method: 'GET', expected: manifest.expected.documents });
  const contextPath = `${content}/context`;
  for (const [name, token, expected] of [
    ['context-success', reader, manifest.expected.context],
    ['unauthenticated', 'verification-invalid-token', manifest.expected.unauthenticated],
    ['unmapped-principal', unmapped, manifest.expected.unmapped],
    ['permission-denied', denied, manifest.expected.denied],
    ['context-recovery', reader, manifest.expected.context],
  ] as const) {
    await execute({ name, path: contextPath, token, method: 'POST',
      context: manifest.contextRequest, expected });
  }
  await execute({ name: 'result-retrieval', path: manifest.resultRetrievalPath, token: reader,
    method: 'GET', expected: manifest.expected.result });
  process.stdout.write(`${JSON.stringify({ actual: true, stage: 'owner-contract-transport-only',
    akbSourceCommit: manifest.ownerContract.sourceCommit, contractDigest: manifest.ownerContract.sha256,
    productionWrites: 0, outcomes, applicationSuccessParserQualified: false })}\n`);
}

process.umask(0o077);
if (process.argv[2] === '--application') {
  const { verifyAkbApplication } = await import('./verify-akb-application.ts');
  await verifyAkbApplication().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ stage: 'paired-application-failed',
      errorKind: error instanceof Error ? error.name : 'unknown' })}\n`);
    process.exitCode = 1;
  });
} else await main();
