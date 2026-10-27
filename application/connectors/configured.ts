import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import type { AgentRuntimeConnector } from '../contracts/index.ts';
import { requireAdministrator, type Actor } from '../domain/authorization.ts';
import { HubError } from '../domain/errors.ts';
import type { Hub } from '../orchestration/hub.ts';
import { ConnectorLedger } from './ledger.ts';
import { DimExecutionConnector, dimConnectionSchema } from './dim.ts';
import { connectionSchema } from './opencode/schema.ts';
import { OpenCodeRuntimeConnector } from './opencode/runtime.ts';
import { readPrivateConfiguration } from './private-config.ts';
import { CodexRuntimeConnector } from './codex/runtime.ts';
import { codexConnectionSchema } from './codex/schema.ts';
import { ClaudeCodeRuntimeConnector } from './claude/runtime.ts';
import { claudeConnectionSchema } from './claude/schema.ts';
import { AkbClient, AkbContextService, akbConnectionSchema } from './akb/index.ts';
import { openCodeInventory, codexInventory, claudeInventory } from './runtime-inventory.ts';

const configurationSchema = z.strictObject({
  opencode: z.array(connectionSchema).max(20).default([]),
  codex: z.array(codexConnectionSchema).max(20).default([]),
  claude: z.array(claudeConnectionSchema).max(20).default([]),
  akb: z.array(akbConnectionSchema).max(20).default([]),
  dim: z.array(dimConnectionSchema).max(20).default([]),
});
export class ConfiguredConnections {
  readonly runtime: Readonly<Record<string, AgentRuntimeConnector>>;
  readonly execution: Readonly<Record<string, DimExecutionConnector>>;
  private readonly ledger: ConnectorLedger;
  private readonly openCode: Readonly<Record<string, OpenCodeRuntimeConnector>>;
  private readonly codex: Readonly<Record<string, CodexRuntimeConnector>>;
  private readonly claude: Readonly<Record<string, ClaudeCodeRuntimeConnector>>;
  private readonly knowledge: Readonly<Record<string, AkbClient>>;
  constructor(path: string, ledgerPath: string) {
    const parsed = configurationSchema.parse(readPrivateConfiguration(path));
    const ids = [...parsed.opencode, ...parsed.codex, ...parsed.claude, ...parsed.akb, ...parsed.dim]
      .map((connection) => connection.installationId);
    if (new Set(ids).size !== ids.length) throw new HubError({ code: 'connection_id_conflict', category: 'validation',
      message: 'Saved connection installation IDs must be unique.', retry: 'never' });
    this.ledger = new ConnectorLedger(ledgerPath);
    this.openCode = Object.fromEntries(parsed.opencode.map((connection) =>
      [connection.installationId, new OpenCodeRuntimeConnector(this.ledger, connection)]));
    this.codex = Object.fromEntries(parsed.codex.map((connection) =>
      [connection.installationId, new CodexRuntimeConnector(this.ledger, connection)]));
    this.claude = Object.fromEntries(parsed.claude.map((connection) =>
      [connection.installationId, new ClaudeCodeRuntimeConnector(this.ledger, connection)]));
    this.knowledge = Object.fromEntries(parsed.akb.map((connection) => [connection.installationId, new AkbClient(connection)]));
    this.runtime = { ...this.openCode, ...this.codex, ...this.claude };
    this.execution = Object.fromEntries(parsed.dim.map((connection) => {
      const native = this.openCode[connection.runtimeInstallationId];
      const cli = this.codex[connection.runtimeInstallationId] ?? this.claude[connection.runtimeInstallationId];
      const mapping = native?.client.connection.environment ?? cli?.state.connection.environment;
      if ((!native && !cli) || !mapping || mapping.executionInstallationId !== connection.installationId ||
        mapping.hostId !== connection.hostId || mapping.workspaceId !== connection.workspaceId || mapping.incarnation !== connection.incarnation) {
        throw new HubError({ code: 'dim_runtime_mapping', category: 'identity_mismatch',
          message: 'Each DIM connection requires an explicitly mapped runtime for the same host and workspace incarnation.', retry: 'never' });
      }
      return [connection.installationId, new DimExecutionConnector(this.ledger, connection, async (ctx) =>
        native ? (await native.client.discover({ ...ctx, installationId: connection.runtimeInstallationId })).directory :
          cli ? await realpath(cli.state.connection.directory) : '')];
    }));
  }
  async discover(actor: Actor) {
    requireAdministrator(actor);
    const safe = async <T>(read: () => Promise<T>) => {
      try { return { status: 'available' as const, value: await read() }; }
      catch (error) {
        if (error instanceof Error) return { status: 'unavailable' as const, error: error instanceof HubError ? error.data : {
          code: 'incompatible_discovery', message: 'The service returned an incompatible discovery response. Check the installed version with its owner.',
        } };
        throw error;
      }
    };
    return {
      runtime: await Promise.all([
        ...Object.entries(this.openCode).map(async ([installationId, connector]) => ({ installationId,
          kind: 'opencode' as const, label: connector.client.connection.label, ...await safe(() => openCodeInventory(connector,
            { workspaceId: actor.workspaceId, installationId, correlationId: 'discovery' })) })),
        ...Object.entries(this.codex).map(async ([installationId, connector]) => ({ installationId,
          kind: 'codex' as const, label: connector.state.connection.label, ...await safe(() => codexInventory(connector,
            { workspaceId: actor.workspaceId, installationId, correlationId: 'discovery' })) })),
        ...Object.entries(this.claude).map(async ([installationId, connector]) => ({ installationId,
          kind: 'claude-code' as const, label: connector.state.connection.label, ...await safe(() => claudeInventory(connector,
            { workspaceId: actor.workspaceId, installationId, correlationId: 'discovery' })) })),
      ]),
      knowledge: Object.entries(this.knowledge).filter(([, client]) => client.connection.workHubWorkspaceId === actor.workspaceId)
        .map(([installationId, client]) => ({ installationId, kind: 'akb' as const, label: client.connection.label })),
      execution: await Promise.all(Object.entries(this.execution).map(async ([installationId, connector]) => ({
        installationId, label: connector.connection.label, ...await safe(() => connector.discover({
          workspaceId: actor.workspaceId, installationId, correlationId: 'discovery' })) }))),
    };
  }
  nativeLink(actor: Actor, hub: Hub, sessionId: string): string | undefined {
    const session = hub.getSession(actor, sessionId).session;
    const connector = this.openCode[session.runtimeInstallationId];
    if (!connector) return undefined;
    const binding = connector.state.get({ workspaceId: actor.workspaceId,
      installationId: session.runtimeInstallationId, correlationId: 'native-link' }, sessionId);
    const template = connector.client.connection.nativeUrlTemplate;
    return binding && template ? template.replace('{sessionID}', encodeURIComponent(binding.nativeId)) : undefined;
  }
  contextService(hub: Hub): AkbContextService {
    return new AkbContextService(this.knowledge, (actor, input) => hub.captureExternalReference(actor, input),
      (actor, taskId) => hub.getTask(actor, taskId).projectId);
  }
  async close(): Promise<void> {
    const runtimes = [...Object.values(this.codex), ...Object.values(this.claude)];
    const results = await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    this.ledger.close();
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime shutdown failed.');
  }
}
