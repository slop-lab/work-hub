import ky from 'ky';
import { z } from 'zod';
import { NativeRefSchema } from '../application/contracts/common.ts';

const failure = z.object({ status: z.literal('unavailable'), error: z.object({ code: z.string(), message: z.string() }) });
const runtimeKind = z.enum(['opencode', 'claude-code', 'codex']);
const runtimeValue = z.object({ version: z.string(), directory: z.string(), agents: z.array(z.string()),
  environment: z.object({ executionInstallationId: z.string() }).nullable(),
  models: z.array(z.object({ providerID: z.string(), modelID: z.string() })),
  sessions: z.array(z.object({ id: z.string(), label: z.string(), nativeSession: NativeRefSchema })),
  limitations: z.array(z.string()).default([]),
});
const executionValue = z.object({ hostId: z.string(), workspaceId: z.string(), incarnation: z.string(),
  displayName: z.string(), identityExpiresAt: z.string(), allowedProjectIds: z.array(z.string()),
  workAreas: z.array(z.object({ key: z.string(), path: z.string(), pathNamespace: z.string(),
    requestedAccess: z.enum(['read', 'write']), preparation: z.enum(['preserve_existing', 'provider_profile']) })),
  resources: z.object({ cpuCount: z.string(), memory: z.string(), pidsLimit: z.string() }), limitations: z.array(z.string()),
});
const runtimeSummary = z.object({ installationId: z.string(), kind: runtimeKind.default('opencode'), label: z.string() });
const executionSummary = z.object({ installationId: z.string(), label: z.string() });
const schema = z.object({
  runtime: z.array(z.intersection(runtimeSummary, z.discriminatedUnion('status', [failure, z.object({ status: z.literal('available'), value: runtimeValue })]))),
  execution: z.array(z.intersection(executionSummary, z.discriminatedUnion('status', [failure, z.object({ status: z.literal('available'), value: executionValue })]))),
});
export type IntegrationInventory = z.infer<typeof schema>;
export function parseIntegrationInventory(value: unknown): IntegrationInventory { return schema.parse(value); }
export async function loadIntegrations(): Promise<IntegrationInventory> {
  return parseIntegrationInventory(await ky.get('/api/v1/integrations', { timeout: 30_000, retry: 0 }).json<unknown>());
}
export async function loadNativeLink(sessionId: string): Promise<string | null> {
  return z.object({ url: z.url().nullable() }).parse(await ky.get(`/api/v1/sessions/${encodeURIComponent(sessionId)}/native-link`,
    { timeout: 10_000, retry: 0 }).json<unknown>()).url;
}
