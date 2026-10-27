import { z } from 'zod';
import { EnvironmentUseGrantSchema } from '../../contracts/execution.ts';

export const claudeConnectionSchema = z.strictObject({
  kind: z.literal('claude-code').optional(),
  installationId: z.string().min(1),
  label: z.string().min(1),
  directory: z.string().startsWith('/'),
  executablePath: z.string().startsWith('/').optional(),
  environment: z.strictObject({ executionInstallationId: z.string().min(1), hostId: z.string().min(1),
    workspaceId: z.string().min(1), incarnation: z.string().min(1) }).optional(),
});
export type ClaudeConnection = z.infer<typeof claudeConnectionSchema>;

export const claudeSelectionSchema = z.strictObject({ model: z.string().min(1) });
export type ClaudeSelection = z.infer<typeof claudeSelectionSchema>;

export const claudeSessionSchema = z.strictObject({
  sessionId: z.string().min(1), summary: z.string().optional(), cwd: z.string().optional(),
  createdAt: z.string().optional(), lastModified: z.string().optional(),
});
export type ClaudeSession = z.infer<typeof claudeSessionSchema>;

export const claudeMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('assistant'), id: z.string(), text: z.string(), observedAt: z.string() }),
  z.strictObject({ kind: z.literal('result'), id: z.string(), outcome: z.enum(['completed', 'failed', 'interrupted']),
    summary: z.string(), observedAt: z.string() }),
]);
export type ClaudeMessage = z.infer<typeof claudeMessageSchema>;
export const claudeBoundMessageSchema = z.strictObject({
  attemptId: z.string(), inputId: z.string(), message: claudeMessageSchema,
});
export type ClaudeBoundMessage = z.infer<typeof claudeBoundMessageSchema>;

export const claudeBindingSchema = z.strictObject({
  workspaceId: z.string(), nativeId: z.string(), mode: z.enum(['observe', 'control']), selection: claudeSelectionSchema,
  detached: z.boolean(), messages: z.array(claudeBoundMessageSchema), environmentGrant: EnvironmentUseGrantSchema.nullable(),
  attempt: z.strictObject({ id: z.string(), taskId: z.string(), generation: z.number().int().nonnegative(),
    inputId: z.string() }).optional(),
});
export type ClaudeBinding = z.infer<typeof claudeBindingSchema>;

export const claudeDiscoverySchema = z.strictObject({
  installationId: z.string(), runtimeKind: z.literal('claude-code'), label: z.string(), version: z.string(),
  profiles: z.array(z.strictObject({ id: z.string(), label: z.string(), models: z.array(z.strictObject({ id: z.string(), label: z.string() })) })),
  sessions: z.array(z.strictObject({ nativeRef: z.strictObject({ installationId: z.string(), providerScope: z.string(),
    kind: z.literal('agent-session'), id: z.string() }), label: z.string().optional(), model: z.string().optional(),
    updatedAt: z.string().optional() })), limitations: z.array(z.string()),
});
export type ClaudeDiscovery = z.infer<typeof claudeDiscoverySchema>;
