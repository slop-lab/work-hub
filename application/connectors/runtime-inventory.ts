import { z } from 'zod';
import type { CallContext } from '../contracts/index.ts';
import type { OpenCodeRuntimeConnector } from './opencode/runtime.ts';
import { sessionSchema } from './opencode/schema.ts';
import type { CodexRuntimeConnector } from './codex/runtime.ts';
import type { ClaudeCodeRuntimeConnector } from './claude/runtime.ts';

export async function openCodeInventory(connector: OpenCodeRuntimeConnector, ctx: CallContext) {
  const inventory = await connector.client.discover(ctx);
  const sessions = z.array(sessionSchema.extend({ title: z.string().optional() })).parse(
    await connector.client.request(ctx, '/session?limit=50')).filter((session) => session.directory === inventory.directory);
  return { ...inventory, environment: connector.client.connection.environment ?? null,
    sessions: sessions.map((session) => ({ id: session.id, label: session.title ?? session.id,
      nativeSession: connector.state.reference('agent-session', session.id) })),
    capabilities: connector.describe().capabilities, limitations: [] };
}

export async function codexInventory(connector: CodexRuntimeConnector, ctx: CallContext) {
  const inventory = await connector.discover(ctx);
  const connection = connector.state.connection;
  return { version: inventory.version, directory: inventory.directory, environment: connection.environment ?? null,
    agents: inventory.agents.map((agent) => agent.id),
    models: inventory.models.filter((model) => model.id === connection.model)
      .map((model) => ({ providerID: connection.modelProvider, modelID: model.id })),
    sessions: inventory.sessions.map((session) => ({ id: session.nativeRef.id, label: session.nativeRef.id,
      nativeSession: session.nativeRef })), capabilities: inventory.capabilities, limitations: inventory.limitations };
}

export async function claudeInventory(connector: ClaudeCodeRuntimeConnector, ctx: CallContext) {
  const inventory = await connector.discover(ctx);
  return { version: `Agent SDK ${inventory.version}`, directory: connector.state.connection.directory,
    environment: connector.state.connection.environment ?? null, agents: ['claude-code'], models: [],
    sessions: inventory.sessions.map((session) => ({ id: session.nativeRef.id,
      label: session.label ?? session.nativeRef.id, nativeSession: session.nativeRef })),
    capabilities: connector.describe().capabilities, limitations: inventory.limitations };
}
