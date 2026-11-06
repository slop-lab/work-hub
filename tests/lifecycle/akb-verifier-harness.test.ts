import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

test('paired AKB verifier requires contract-bound expected responses and never qualifies application parsing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workhub-akb-harness-'));
  const paths: string[] = [];
  let responseMode: 'normal' | 'mismatch' | 'invalid_json' = 'normal';
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    const token = request.headers.authorization;
    const result = token === 'Bearer reader' ? { status: 200, body: { fixture: request.method === 'GET' ? 'retrieved' : 'context' } }
      : token === 'Bearer unmapped' ? { status: 403, body: { fixture: 'unmapped' } }
        : token === 'Bearer denied' ? { status: 404, body: { fixture: 'denied' } }
          : { status: 401, body: { fixture: 'unauthenticated' } };
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(responseMode === 'mismatch' ? JSON.stringify({ privateBody: 'MISMATCH_BODY_SENTINEL' })
      : responseMode === 'invalid_json' ? '{"privateBody":"INVALID_JSON_BODY_SENTINEL",broken'
        : JSON.stringify(result.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const contract = 'Synthetic harness contract, not an AKB owner response.';
    const contractPath = join(root, 'contract.txt');
    writeFileSync(contractPath, contract, { mode: 0o600 });
    for (const token of ['reader', 'unmapped', 'denied']) {
      writeFileSync(join(root, `${token}.json`), JSON.stringify({ token }), { mode: 0o600 });
    }
    const manifestPath = join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      format: 'workhub.akb-paired-verification.v1',
      ownerContract: { path: contractPath, sha256: createHash('sha256').update(contract).digest('hex'), sourceCommit: 'a'.repeat(40) },
      origin: `http://127.0.0.1:${address.port}`, workspaceId: 'fixture',
      principals: { reader: join(root, 'reader.json'), unmapped: join(root, 'unmapped.json'), denied: join(root, 'denied.json') },
      documentsQuery: { kind: 'page', query: 'fixture', limit: 1 },
      contextRequest: { references: [{ kind: 'page', id: 'fixture', revision: 1 }], maxBytes: 65536 },
      resultRetrievalPath: '/api/knowledge/v1/workspaces/fixture/proposals/fixture',
      expected: { documents: { status: 200, body: { fixture: 'retrieved' } },
        context: { status: 200, body: { fixture: 'context' } },
        unauthenticated: { status: 401, body: { fixture: 'unauthenticated' } },
        unmapped: { status: 403, body: { fixture: 'unmapped' } }, denied: { status: 404, body: { fixture: 'denied' } },
        result: { status: 200, body: { fixture: 'retrieved' } } },
    }), { mode: 0o600 });
    const run = async () => {
      const child = spawn(process.execPath, ['scripts/verify-akb-paired.ts', '--run', manifestPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      const [code] = await once(child, 'close');
      return { code, output, errors };
    };
    const success = await run();
    assert.equal(success.code, 0, success.errors);
    const receipt = z.object({ applicationSuccessParserQualified: z.boolean() }).parse(JSON.parse(success.output));
    assert.equal(receipt.applicationSuccessParserQualified, false);
    assert.equal(paths.filter((path) => path.startsWith('POST ')).length, 5);
    assert.ok(paths.every((path) => path.startsWith('GET /api/') || path === 'POST /api/content/v1/workspaces/fixture/context'));
    for (const mode of ['mismatch', 'invalid_json'] as const) {
      responseMode = mode;
      const failed = await run();
      assert.notEqual(failed.code, 0);
      assert.equal(`${failed.output}${failed.errors}`.includes('MISMATCH_BODY_SENTINEL'), false);
      assert.equal(`${failed.output}${failed.errors}`.includes('INVALID_JSON_BODY_SENTINEL'), false);
    }
    responseMode = 'normal';
    writeFileSync(join(root, 'reader.json'), '{"token":"MALFORMED_TOKEN_SENTINEL",broken', { mode: 0o600 });
    const malformedToken = await run();
    assert.notEqual(malformedToken.code, 0);
    assert.equal(`${malformedToken.output}${malformedToken.errors}`.includes('MALFORMED_TOKEN_SENTINEL'), false);
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(root, { recursive: true, force: true });
  }
});
