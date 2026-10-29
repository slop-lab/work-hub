import { ConnectorLedger } from '../application/connectors/ledger.ts';
import type { CodexProtocol, CodexProtocolEvent } from '../application/connectors/codex/protocol.ts';
import { CodexRuntimeConnector } from '../application/connectors/codex/runtime.ts';
import type { ActionContext, AttemptStart } from '../application/contracts/index.ts';
import { digest } from '../application/persistence/codec.ts';

export const codexContext = (operationId: string): ActionContext => ({
  workspaceId: 'hub', installationId: 'codex-test', correlationId: operationId,
  commandId: operationId, operationId, inputDigest: digest(operationId),
  authorizedGrantRefs: ['codex:logical'],
});

export class FakeCodexProtocol implements CodexProtocol {
  readonly calls: { readonly method: string; readonly params: unknown }[] = [];
  readonly events: CodexProtocolEvent[] = [];
  readonly threads = new Map<string, unknown>();
  readonly serverResponses: { readonly nativeRequestId: string; readonly result: unknown }[] = [];
  readonly serverRequests = new Map<string, CodexProtocolEvent>();
  persistTurn = true;
  authenticated = true;
  async version(): Promise<string> { return '0.164.0'; }
  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    switch (method) {
      case 'account/read': return { account: this.authenticated ? { type: 'apiKey' } : null, requiresOpenaiAuth: true };
      case 'model/list': return { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture Model', hidden: false, isDefault: true }], nextCursor: null };
      case 'thread/list': return { data: [...this.threads.values()], nextCursor: null };
      case 'thread/start': {
        const thread = { id: '01900000-0000-7000-8000-000000000001', sessionId: '01900000-0000-7000-8000-000000000001',
          ephemeral: false, cwd: '/fixture', modelProvider: 'openai', model: 'fixture-model', cliVersion: '0.164.0',
          status: { type: 'idle' }, createdAt: 1, updatedAt: 1, turns: [] };
        this.threads.set(thread.id, thread);
        return { thread, model: 'fixture-model', modelProvider: 'openai', cwd: '/fixture' };
      }
      case 'thread/resume': {
        const id = (params as { readonly threadId: string }).threadId;
        const thread = this.threads.get(id);
        if (!thread) throw new Error('thread missing');
        return { thread, model: 'fixture-model', modelProvider: 'openai', cwd: '/fixture' };
      }
      case 'turn/start': {
        const input = params as { readonly threadId: string; readonly clientUserMessageId: string; readonly input: readonly unknown[] };
        const turn = { id: '01900000-0000-7000-8000-000000000002', status: 'inProgress', startedAt: 2, completedAt: null,
          error: null, items: [{ type: 'userMessage', id: 'user-1', clientId: input.clientUserMessageId, content: input.input }] };
        if (this.persistTurn) {
          const thread = this.threads.get(input.threadId) as { readonly turns: readonly unknown[] };
          this.threads.set(input.threadId, { ...thread, status: { type: 'active', activeFlags: [] }, turns: [...thread.turns, turn] });
        }
        return { turn };
      }
      case 'thread/read': {
        const id = (params as { readonly threadId: string }).threadId;
        const thread = this.threads.get(id);
        if (!thread) throw new Error('thread missing');
        return { thread };
      }
      case 'turn/interrupt': return {};
      default: throw new Error(`Unexpected method ${method}`);
    }
  }
  trackSubmission(_threadId: string, _clientId: string): void {}
  trackAcceptedTurn(_threadId: string, _clientId: string, _turnId: string): void {}
  forgetSubmission(_threadId: string, _clientId: string): void {}
  drainEvents(): readonly CodexProtocolEvent[] { return this.events.splice(0); }
  queueServerRequest(event: CodexProtocolEvent & { readonly nativeRequestId: string }): void {
    this.events.push(event); this.serverRequests.set(event.nativeRequestId, event);
  }
  pendingServerRequests(): readonly CodexProtocolEvent[] { return [...this.serverRequests.values()]; }
  async respondServerRequest(nativeRequestId: string, result: unknown): Promise<void> {
    this.serverResponses.push({ nativeRequestId, result });
    this.serverRequests.delete(nativeRequestId);
  }
  async close(): Promise<void> {}
}

export function codexFixture() {
  const protocol = new FakeCodexProtocol();
  const ledger = new ConnectorLedger(':memory:');
  const connection = { kind: 'codex' as const, installationId: 'codex-test', label: 'Fixture Codex', executable: '/fixture/codex',
    directory: '/fixture', codexHome: '/fixture/codex-home', modelProvider: 'openai', model: 'fixture-model' };
  const connector = new CodexRuntimeConnector(ledger, connection, protocol);
  const open = () => connector.openSession(codexContext('open'), { hubSessionId: 'logical', mode: 'create',
    sessionLaunchOwner: 'runtime_connector', requestedControl: 'control', configuration: { agent: 'codex', model: { providerID: 'openai', modelID: 'fixture-model' }, projectId: 'project-default' },
    route: { kind: 'external', route: { id: 'configured', ownerInstallationId: 'codex-test', kind: 'stdio' } } });
  const nativeSession = { installationId: 'codex-test', providerScope: '/fixture', kind: 'agent-thread', id: '01900000-0000-7000-8000-000000000001' };
  const target = { hubSessionId: 'logical', hubAttemptId: 'attempt', bindingGeneration: 1,
    controlGrantRef: 'codex:logical', nativeSession };
  const instruction = 'Fixture work';
  const input: AttemptStart = { target, workAreas: [], input: { id: 'snapshot', digest: digest('snapshot'), taskId: 'task',
    taskRevision: 1, scopeRevision: 1, profileId: 'profile', profileRevision: 1, instruction, promptDigest: digest(instruction),
    selectedReferenceIds: [], selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [], assembledAt: new Date(0).toISOString() } };
  return { connector, ledger, protocol, connection, open, target, input, close: async () => { await connector.close(); ledger.close(); } };
}
