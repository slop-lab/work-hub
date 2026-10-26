import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { z } from 'zod';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const processFailure = z.object({ code: z.number(), stdout: z.string(), stderr: z.string() });

async function snapshotFixture(ancestor: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'workhub-source-snapshot-'));
  const directory = join(root, 'snapshot');
  const scratch = join(root, 'scratch');
  await mkdir(directory);
  await mkdir(scratch);
  const environment: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch };
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
  environment['GIT_CONFIG_NOSYSTEM'] = '1';
  environment['GIT_CONFIG_GLOBAL'] = '/dev/null';
  const listed = await execute('git', ['ls-files', '-z'], { cwd: repository, maxBuffer: 4 * 1024 * 1024 });
  const files = listed.stdout.split('\0').filter(Boolean);
  for (const path of files) {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(repository, path), destination, { dereference: false, preserveTimestamps: true });
  }
  if (ancestor) {
    await execute('git', ['init', '--quiet', root], { env: environment });
    await writeFile(join(root, 'parent-only.txt'), 'parent fixture\n');
    await execute('git', ['-C', root, 'add', 'parent-only.txt'], { env: environment });
  }
  return { root, directory, scratch, environment, fileCount: files.length,
    close: () => rm(root, { recursive: true, force: true }) };
}

async function runSource(fixture: Awaited<ReturnType<typeof snapshotFixture>>) {
  try {
    const result = await execute('bash', ['scripts/ci/source.bash'], {
      cwd: fixture.directory, env: fixture.environment, timeout: 210_000, maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    if (error instanceof Error) {
      const failure = processFailure.safeParse(error);
      if (failure.success) return failure.data;
    }
    throw error;
  }
}

test('the complete authoritative metadata-free snapshot passes the actual source entrypoint', { timeout: 240_000 }, async () => {
  const fixture = await snapshotFixture(false);
  try {
    await assert.rejects(access(join(fixture.directory, '.git')), { code: 'ENOENT' });
    const result = await runSource(fixture);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /qg check --full/);
    assert.match(result.stdout, /PASS/);
    await access(join(fixture.directory, 'dist/web/app.js'));
    await assert.rejects(access(join(fixture.directory, '.git')), { code: 'ENOENT' });
    assert.equal((await readdir(fixture.scratch)).some((name) => name.startsWith('work-hub-source-git.')), false);
    console.log(JSON.stringify({ acceptance: 'metadata-free-source', suppliedFiles: fixture.fileCount, sourceExit: result.code, persistedGitMetadata: false }));
  } finally { await fixture.close(); }
});

test('snapshot policy rejects ignored local-only source and never adopts ancestor Git membership', { timeout: 240_000 }, async () => {
  const fixture = await snapshotFixture(true);
  const relative = '.local/snapshot-policy-violation.txt';
  try {
    await mkdir(join(fixture.directory, '.local'));
    await writeFile(join(fixture.directory, relative), 'synthetic non-secret policy fixture\n');
    await writeFile(join(fixture.directory, '.gitignore'), '\n.local/\n', { flag: 'a' });
    const result = await runSource(fixture);
    assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /git\/no-tracked-local-files/);
    assert.ok(result.stdout.includes(relative));
    assert.equal(await readFile(join(fixture.directory, relative), 'utf8'), 'synthetic non-secret policy fixture\n');
    const parent = await execute('git', ['-C', fixture.root, 'ls-files'], { env: fixture.environment });
    assert.equal(parent.stdout, 'parent-only.txt\n');
    await assert.rejects(access(join(fixture.directory, '.git')), { code: 'ENOENT' });
    assert.equal((await readdir(fixture.scratch)).some((name) => name.startsWith('work-hub-source-git.')), false);
    console.log(JSON.stringify({ acceptance: 'metadata-free-policy-enforcement', sourceExit: result.code, rejectedPath: relative, ancestorIndexPreserved: true }));
  } finally { await fixture.close(); }
});
