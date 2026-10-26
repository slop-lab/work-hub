import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApplication } from '../application/api/app.ts';
import { AuthStore } from '../application/api/auth-store.ts';
import { ConfiguredConnections } from '../application/connectors/configured.ts';
import { Hub } from '../application/orchestration/hub.ts';
import { startNativeOpenCode } from './native-opencode.ts';

export async function startLiveHub() {
  const native = await startNativeOpenCode();
  const root = mkdtempSync(join(tmpdir(), 'workhub-backend-'));
  const config = join(root, 'connections.json');
  writeFileSync(config, JSON.stringify({ opencode: [native.connection] }), { mode: 0o600 });
  const auth = new AuthStore(join(root, 'auth.sqlite'));
  const token = auth.bootstrap('user-admin');
  let connections = new ConfiguredConnections(config, join(root, 'connectors.sqlite'));
  let hub = new Hub(join(root, 'hub.sqlite'), { mode: 'external', connectors: {
    execution: connections.execution, runtime: connections.runtime,
  } });
  let app: ReturnType<typeof createApplication> | undefined;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app ? app.fetch(request) : new Response(null, { status: 503 }) });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected live Hub port');
  const url = `http://127.0.0.1:${address.port}`;
  const webRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
  const application = () => {
    const value = createApplication({ hub, auth, connections, origin: url, secureCookies: false });
    value.get('/app.js', serveStatic({ root: webRoot }));
    value.get('/app.css', serveStatic({ root: webRoot }));
    value.get('/', serveStatic({ path: join(webRoot, 'index.html') }));
    return value;
  };
  app = application();
  let working: Promise<unknown> | undefined;
  const work = () => {
    if (working) return;
    working = hub.reconcile().finally(() => { working = undefined; });
  };
  let timer = setInterval(work, 100);
  return { url, token, native,
    hub: () => hub,
    restart: async () => {
      clearInterval(timer);
      await working;
      hub.close(); connections.close();
      connections = new ConfiguredConnections(config, join(root, 'connectors.sqlite'));
      hub = new Hub(join(root, 'hub.sqlite'), { mode: 'external', connectors: {
        execution: connections.execution, runtime: connections.runtime,
      } });
      app = application();
      timer = setInterval(work, 100);
    },
    close: async () => {
      clearInterval(timer); await working;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      hub.close(); connections.close(); auth.close();
      await native.close(); rmSync(root, { recursive: true, force: true });
    },
  };
}
