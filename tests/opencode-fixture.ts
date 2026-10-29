import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { ConnectorLedger } from '../application/connectors/ledger.ts';
import { OpenCodeRuntimeConnector } from '../application/connectors/opencode/runtime.ts';
import { messageSchema } from '../application/connectors/opencode/schema.ts';
import { digest } from '../application/persistence/codec.ts';
import type { ActionContext, AttemptStart } from '../application/contracts/index.ts';

export const context = (operationId: string): ActionContext => ({ workspaceId: 'hub', installationId: 'opencode-test',
  correlationId: operationId, commandId: operationId, operationId, inputDigest: digest(operationId), authorizedGrantRefs: ['opencode:logical'] });
export const selection = { agent: 'fixture-agent', model: { providerID: 'fixture-provider', modelID: 'fixture-model' }, projectId: 'project-default' };
export async function openCodeFixture() {
  const messages: z.infer<typeof messageSchema>[] = [];
  const childMessages = new Map<string, z.infer<typeof messageSchema>[]>();
  const calls: { method: string; path: string; search: string; body: unknown }[] = [];
  const state = { persist: true, agentAvailable: true, directory: '/fixture', question: false,
    statuses: {} as Record<string, { type: 'idle' | 'busy' | 'retry'; attempt?: number; message?: string; next?: number }>,
    children: new Map<string, { id: string; directory: string; parentID: string }[]>(),
    statusAvailable: true, childrenAvailable: true };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ method: req.method ?? '', path: url.pathname, search: url.search, body });
    const send = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer fixture-only') return send({}, 401);
    switch (url.pathname) {
      case '/global/health': return send({ healthy: true, version: 'fixture' });
      case '/path': return send({ directory: state.directory });
      case '/agent': return send(state.agentAvailable ? [{ name: selection.agent, mode: 'primary', hidden: null }] : []);
      case '/provider': return send({ connected: ['fixture-provider'], all: [{ id: 'fixture-provider', models: { 'fixture-model': {} } }] });
      case '/config/providers': return send({ providers: [{ id: 'fixture-provider', models: { 'fixture-model': {} } }], default: {} });
      case '/session': return send(req.method === 'POST' ? { id: 'ses_fixture', directory: state.directory } : [{ id: 'ses_fixture', directory: state.directory }]);
      case '/session/status': return state.statusAvailable ? send(state.statuses) : send({}, 503);
      case '/session/ses_fixture': return send({ id: 'ses_fixture', directory: state.directory });
      case '/session/ses_fixture/prompt_async': {
        const prompt = z.object({ messageID: z.string(), parts: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(body);
        if (state.persist) messages.push({ info: { id: prompt.messageID, sessionID: 'ses_fixture', role: 'user', time: { created: 1 } },
          parts: prompt.parts.map((part, index) => ({ ...part, id: `prt_${index}` })) });
        res.writeHead(204); res.end(); return;
      }
      case '/session/ses_fixture/message': return send(messages);
      case '/question': return send(state.question ? [{ id: 'que_fixture', sessionID: 'ses_fixture', tool: { messageID: 'msg_assistant', callID: 'call' },
        questions: [{ question: 'Choose a fixture value', header: 'Value', options: [], custom: true }] }] : []);
      case '/question/que_fixture/reply': state.question = false; return send(true);
      case '/session/ses_fixture/abort': return send(true);
      default: {
        const childMatch = /^\/session\/(ses_[^/]+)\/children$/.exec(url.pathname);
        if (childMatch) return state.childrenAvailable ? send(state.children.get(childMatch[1] ?? '') ?? []) : send({}, 503);
        const messageMatch = /^\/session\/(ses_[^/]+)\/message$/.exec(url.pathname);
        if (messageMatch) return send(childMessages.get(messageMatch[1] ?? '') ?? []);
        const sessionMatch = /^\/session\/(ses_[^/]+)$/.exec(url.pathname);
        if (sessionMatch) return send({ id: sessionMatch[1], directory: state.directory });
        const id = url.pathname.split('/').at(-1);
        const message = messages.find((item) => item.info.id === id);
        return send(message ?? {}, message ? 200 : 404);
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected fixture port');
  const connection = { installationId: 'opencode-test', label: 'Fixture', origin: `http://127.0.0.1:${address.port}`,
    directory: '/fixture', authorization: 'Bearer fixture-only' };
  const ledger = new ConnectorLedger(':memory:');
  const connector = new OpenCodeRuntimeConnector(ledger, connection);
  const open = () => connector.openSession(context('open'), { hubSessionId: 'logical', mode: 'create',
    sessionLaunchOwner: 'runtime_connector', requestedControl: 'control', configuration: selection,
    route: { kind: 'external', route: { id: 'configured', ownerInstallationId: 'opencode-test', kind: 'http' } } });
  const target = { hubSessionId: 'logical', hubAttemptId: 'attempt', bindingGeneration: 1,
    controlGrantRef: 'opencode:logical', nativeSession: connector.state.reference('agent-session', 'ses_fixture') };
  const input: AttemptStart = { target, workAreas: [], input: { id: 'snapshot', digest: digest('snapshot'), taskId: 'task',
    taskRevision: 1, profileId: 'profile', profileRevision: 1, instruction: 'Fixture work', selectedReferenceIds: [],
    selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [], assembledAt: new Date(0).toISOString() } };
  return { connector, ledger, connection, messages, childMessages, calls, state, open, target, input,
    close: async () => { ledger.close(); server.close(); await once(server, 'close'); } };
}
