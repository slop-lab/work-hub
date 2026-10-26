import { z } from 'zod';
import { requireAdministrator, type Actor } from '../domain/authorization.ts';
import { HubError } from '../domain/errors.ts';
import type { Hub } from '../orchestration/hub.ts';
import { ConnectorLedger } from './ledger.ts';
import { DimExecutionConnector, dimConnectionSchema } from './dim.ts';
import { connectionSchema, sessionSchema } from './opencode/schema.ts';
import { OpenCodeRuntimeConnector } from './opencode/runtime.ts';
import { readPrivateConfiguration } from './private-config.ts';

const configurationSchema = z.strictObject({
  opencode: z.array(connectionSchema).max(20), dim: z.array(dimConnectionSchema).max(20).default([]),
});
export class ConfiguredConnections {
  readonly runtime: Readonly<Record<string, OpenCodeRuntimeConnector>>;
  readonly execution: Readonly<Record<string, DimExecutionConnector>>;
  private readonly ledger: ConnectorLedger;
  constructor(path: string, ledgerPath: string) {
    const parsed = configurationSchema.parse(readPrivateConfiguration(path));
    const ids = [...parsed.opencode, ...parsed.dim].map((connection) => connection.installationId);
    if (new Set(ids).size !== ids.length) throw new HubError({ code: 'connection_id_conflict', category: 'validation',
      message: 'Saved connection installation IDs must be unique.', retry: 'never' });
    this.ledger = new ConnectorLedger(ledgerPath);
    this.runtime = Object.fromEntries(parsed.opencode.map((connection) =>
      [connection.installationId, new OpenCodeRuntimeConnector(this.ledger, connection)]));
    this.execution = Object.fromEntries(parsed.dim.map((connection) => {
      const runtime = this.runtime[connection.runtimeInstallationId];
      const mapping = runtime?.client.connection.environment;
      if (!runtime || !mapping || mapping.executionInstallationId !== connection.installationId ||
        mapping.hostId !== connection.hostId || mapping.workspaceId !== connection.workspaceId || mapping.incarnation !== connection.incarnation) {
        throw new HubError({ code: 'dim_runtime_mapping', category: 'identity_mismatch',
          message: 'Each DIM connection requires an explicitly mapped OpenCode connection for the same host and workspace incarnation.', retry: 'never' });
      }
      return [connection.installationId, new DimExecutionConnector(this.ledger, connection, async (ctx) =>
        (await runtime.client.discover({ ...ctx, installationId: connection.runtimeInstallationId })).directory)];
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
      runtime: await Promise.all(Object.entries(this.runtime).map(async ([installationId, connector]) => ({
        installationId, label: connector.client.connection.label, ...await safe(async () => {
          const ctx = { workspaceId: actor.workspaceId, installationId, correlationId: 'discovery' };
          const inventory = await connector.client.discover(ctx);
          const sessions = z.array(sessionSchema.extend({ title: z.string().optional() })).parse(
            await connector.client.request(ctx, '/session?limit=50')).filter((session) => session.directory === inventory.directory);
          return { ...inventory, environment: connector.client.connection.environment ?? null,
            sessions: sessions.map((session) => ({ id: session.id, label: session.title ?? session.id,
            nativeSession: connector.state.reference('agent-session', session.id) })), capabilities: connector.describe().capabilities };
        }) }))),
      execution: await Promise.all(Object.entries(this.execution).map(async ([installationId, connector]) => ({
        installationId, label: connector.connection.label, ...await safe(() => connector.discover({
          workspaceId: actor.workspaceId, installationId, correlationId: 'discovery' })) }))),
    };
  }
  nativeLink(actor: Actor, hub: Hub, sessionId: string): string | undefined {
    const session = hub.getSession(actor, sessionId).session;
    const connector = this.runtime[session.runtimeInstallationId];
    if (!connector) return undefined;
    const binding = connector.state.get({ workspaceId: actor.workspaceId,
      installationId: session.runtimeInstallationId, correlationId: 'native-link' }, sessionId);
    const template = connector.client.connection.nativeUrlTemplate;
    return binding && template ? template.replace('{sessionID}', encodeURIComponent(binding.nativeId)) : undefined;
  }
  close(): void { this.ledger.close(); }
}
