import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readPrivateConfiguration } from '../application/connectors/private-config.ts';
import { connectionSchema } from '../application/connectors/opencode/schema.ts';

process.umask(0o077);
const path = resolve(process.env['WORK_HUB_CONNECTIONS'] ?? './data/live-connections.json');
const directory = resolve('./.deps/opencode-dev-workdir');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
mkdirSync(directory, { recursive: true, mode: 0o700 });
const password = randomBytes(32).toString('base64url');
const connection = connectionSchema.parse({ installationId: 'opencode-dev-disposable', label: 'Dedicated OpenCode dev fixture',
  origin: 'http://127.0.0.1:4198', directory, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
  ...(process.env['WORK_HUB_NATIVE_PUBLIC_ORIGIN'] === undefined ? {} : { nativeUrlTemplate: process.env['WORK_HUB_NATIVE_PUBLIC_ORIGIN'] }),
});
try { writeFileSync(path, JSON.stringify({ opencode: [connection], dim: [] }), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
const saved = z.strictObject({ opencode: z.tuple([connectionSchema]), dim: z.tuple([]) }).parse(readPrivateConfiguration(path)).opencode[0];
if (saved.origin !== connection.origin || saved.directory !== directory || saved.installationId !== connection.installationId ||
  !saved.authorization.startsWith('Basic ')) throw new Error('This helper only starts its dedicated disposable dev connection.');
const credential = Buffer.from(saved.authorization.slice(6), 'base64').toString('utf8');
if (!credential.startsWith('opencode:')) throw new Error('Dedicated dev credential has an incompatible username.');
const child = spawn('opencode', ['serve', '--port', '4198', '--hostname', '127.0.0.1'], { cwd: directory,
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: credential.slice('opencode:'.length) }, stdio: 'inherit' });
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.once('SIGINT', () => child.kill('SIGINT'));
await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => {
  process.exitCode = code ?? 1; resolve();
}); });
