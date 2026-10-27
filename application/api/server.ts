import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hub } from '../orchestration/hub.ts';
import { AuthStore } from './auth-store.ts';
import { createApplication } from './app.ts';
import { loadConfig } from './config.ts';
import { logger } from './logger.ts';
import { ConfiguredConnections } from '../connectors/configured.ts';

process.umask(0o077);
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const connectionFile = process.env['WORK_HUB_CONNECTIONS'];
const connections = connectionFile === undefined ? undefined : new ConfiguredConnections(connectionFile, join(config.dataDir, 'connectors.sqlite'));
const hub = new Hub(join(config.dataDir, 'hub.sqlite'), connections === undefined ? {} : {
  mode: 'external', connectors: { runtime: connections.runtime, execution: connections.execution },
});
const auth = new AuthStore(join(config.dataDir, 'auth.sqlite'));
const app = createApplication({ hub, auth, origin: config.origin, secureCookies: config.secureCookies,
  ...(connections === undefined ? {} : { connections }) });
const webRoot = fileURLToPath(new URL('../../dist/web/', import.meta.url));
app.get('/app.js', serveStatic({ root: webRoot }));
app.get('/app.css', serveStatic({ root: webRoot }));
app.get('/', serveStatic({ path: join(webRoot, 'index.html') }));
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'This resource does not exist.' } }, 404));

let stopping = false;
let work: Promise<void> | undefined;
async function processWork(): Promise<void> {
  if (work || stopping) return;
  work = (async () => {
    await hub.reconcile();
    await hub.drain();
  })();
  try { await work; }
  catch (error) {
    if (error instanceof Error) logger.error({ err: error }, 'worker.processing_failed');
    else throw error;
  } finally { work = undefined; }
}
await processWork();
const timer = setInterval(() => { void processWork(); }, config.workerIntervalMs);
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  logger.info({ host: config.host, port: config.port, simulation: hub.readiness.simulated, liveReady: false }, 'service.listening');
});
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  try { await work; }
  finally {
    try { await connections?.close(); }
    finally {
      try { hub.close(); }
      finally { auth.close(); }
    }
  }
  logger.info('service.stopped_without_external_termination');
}
function requestShutdown(): void {
  void shutdown().catch((error: unknown) => {
    process.exitCode = 1;
    logger.error({ errorKind: error instanceof Error ? error.name : 'unknown' }, 'service.shutdown_failed');
  });
}
process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
