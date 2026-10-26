import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { OpenCodeClient } from '../application/connectors/opencode/client.ts';

export async function startNativeOpenCode() {
  const root = mkdtempSync(join(tmpdir(), 'workhub-native-'));
  const password = randomUUID();
  const child = spawn('opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: root, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Disposable OpenCode startup exceeded 30 seconds.')); }, 30_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Disposable OpenCode exited before readiness. Inspect its operator setup.')); });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8192);
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.stderr.resume();
  });
  const connection = { installationId: 'opencode-disposable', label: 'Disposable native acceptance',
    origin, directory: root, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  const client = new OpenCodeClient(connection);
  return { root, connection, client, close: async () => {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    rmSync(root, { recursive: true, force: true });
  } };
}
