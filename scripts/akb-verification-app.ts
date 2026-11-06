import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import ky from 'ky';

import { AuthStore } from '../application/api/auth-store.ts';
import { createApplication } from '../application/api/app.ts';
import { ConfiguredConnections } from '../application/connectors/configured.ts';
import { akbConnectionSchema, type AkbConnection } from '../application/connectors/akb/schema.ts';
import { Hub } from '../application/orchestration/hub.ts';
import type { Actor } from '../application/domain/authorization.ts';
import type { JsonValue } from '../application/contracts/common.ts';

export async function createIsolatedAkbApplication(buildConnection: (actor: Actor, projectId: string) => AkbConnection) {
  const root = mkdtempSync(join(tmpdir(), 'workhub-real-akb-'));
  const hubPath = join(root, 'hub.sqlite');
  const configPath = join(root, 'connections.json');
  const auth = new AuthStore(join(root, 'auth.sqlite'));
  const administratorToken = auth.bootstrap('user-admin');
  let hub = new Hub(hubPath);
  const administrator = hub.actorForUser('user-admin');
  assert.ok(administrator);
  const project = await hub.execute(administrator, { commandId: 'verification-project', type: 'project.create',
    payload: { name: 'Disposable real AKB paired verification' } });
  const projectId = project.objectRefs[0]?.id;
  assert.ok(projectId);
  const member = await hub.execute(administrator, { commandId: 'verification-member', type: 'user.create',
    payload: { displayName: 'Not mapped to AKB installation', role: 'member', projectIds: [projectId],
      profileIds: [], bindingIds: [] } });
  const memberId = member.objectRefs[0]?.id;
  assert.ok(memberId);
  const memberToken = auth.issueUser(memberId);
  const task = await hub.execute(administrator, { commandId: 'verification-task', type: 'task.create',
    payload: { projectId, title: 'Actual pinned AKB Page and Knowledge capture' } });
  const taskId = task.objectRefs[0]?.id;
  assert.ok(taskId);
  const initial = akbConnectionSchema.parse(buildConnection(administrator, projectId));
  const writeConfiguration = (changes: Partial<Pick<AkbConnection, 'authorization' | 'workHubWorkspaceId'>>) => {
    writeFileSync(configPath, JSON.stringify({ akb: [{ ...initial, ...changes }] }), { mode: 0o600 });
  };
  hub.close();
  writeConfiguration({});
  let connections = new ConfiguredConnections(configPath, join(root, 'connectors.sqlite'));
  hub = new Hub(hubPath, { mode: 'external', connectors: { runtime: connections.runtime, execution: connections.execution } });
  let app: ReturnType<typeof createApplication> | undefined;
  const server = serve({ hostname: '127.0.0.1', port: 0,
    fetch: (request) => app === undefined ? new Response(null, { status: 503 }) : app.fetch(request) });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const application = () => createApplication({ hub, auth, connections, origin, secureCookies: false });
  app = application();
  const login = async (token: string) => {
    const response = await ky.post(`${origin}/api/v1/login`, { headers: { origin }, json: { token }, retry: 0 });
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  };
  const cookies = { administrator: await login(administratorToken), member: await login(memberToken) };
  return { origin, projectId, taskId, administratorId: administrator.id, memberId,
    workspaceId: administrator.workspaceId,
    api(input: { readonly path: string; readonly body?: JsonValue; readonly principal?: keyof typeof cookies }) {
      return ky(`${origin}/api/v1${input.path}`, { method: input.body === undefined ? 'get' : 'post',
        headers: { origin, cookie: cookies[input.principal ?? 'administrator'] },
        ...(input.body === undefined ? {} : { json: input.body }),
        retry: 0, timeout: 20_000, redirect: 'error', throwHttpErrors: false });
    },
    async restart(changes: Partial<Pick<AkbConnection, 'authorization' | 'workHubWorkspaceId'>> = {}) {
      app = undefined;
      await connections.close();
      hub.close();
      writeConfiguration(changes);
      connections = new ConfiguredConnections(configPath, join(root, 'connectors.sqlite'));
      hub = new Hub(hubPath, { mode: 'external', connectors: { runtime: connections.runtime, execution: connections.execution } });
      app = application();
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await connections.close();
      hub.close();
      auth.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
