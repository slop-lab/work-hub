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
  z.strictObject({ kind: z.literal('assistant'), frame: z.literal('checkpoint').optional(), id: z.string(),
    text: z.string(), partial: z.boolean().optional(), observedAt: z.string() }),
  z.strictObject({ kind: z.literal('tool'), id: z.string(), toolUseId: z.string(), toolName: z.string(),
    parentToolUseId: z.string().nullable(), elapsedSeconds: z.number().nonnegative(), taskId: z.string().optional(),
    heartbeat: z.boolean().optional(), subagentType: z.string().optional(), retry: z.strictObject({ agentId: z.string(), attempt: z.number().int().positive(),
      maxRetries: z.number().int().nonnegative(), retryDelayMs: z.number().nonnegative(), errorStatus: z.number().nullable(),
      errorCategory: z.string() }).optional(), observedAt: z.string() }),
  z.strictObject({ kind: z.literal('subagent'), id: z.string(), event: z.enum(['started', 'progress', 'updated',
    'completed', 'failed', 'stopped']), taskId: z.string(), runId: z.string().optional(), toolUseId: z.string().optional(),
    description: z.string().optional(), subagentType: z.string().optional(), parentTaskId: z.string().optional(),
    phase: z.enum(['running', 'completed', 'failed', 'stopped', 'unknown']), ambient: z.boolean(),
    taskType: z.string().optional(), isBackgrounded: z.boolean().optional(), spawnDepth: z.number().int().nonnegative().optional(),
    workflowName: z.string().optional(), skipTranscript: z.boolean().optional(), lastToolName: z.string().optional(),
    outputFile: z.string().optional(), error: z.string().optional(), usage: z.strictObject({ totalTokens: z.number().nonnegative(),
      toolUses: z.number().int().nonnegative(), durationMs: z.number().nonnegative() }).optional(),
    summary: z.string().optional(), observedAt: z.string() }),
  z.strictObject({ kind: z.literal('subagent_registry'), id: z.string(), tasks: z.array(z.strictObject({
    taskId: z.string(), runId: z.string().optional(), taskType: z.string(), subagentType: z.string().optional(),
    description: z.string(), parentTaskId: z.string().optional(), ambient: z.boolean(),
  })).max(32), truncated: z.boolean(), observedAt: z.string() }),
  z.strictObject({ kind: z.literal('retry'), id: z.string(), attempt: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(), retryDelayMs: z.number().nonnegative(), errorStatus: z.number().nullable(),
    error: z.string(), noResponse: z.strictObject({ waitedMs: z.number().nonnegative(), retryWaitMs: z.number().nonnegative() }).optional(),
    observedAt: z.string() }),
  z.strictObject({ kind: z.literal('rate_limit'), id: z.string(), status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    resetsAt: z.number().optional(), rateLimitType: z.enum(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet',
      'seven_day_overage_included', 'overage']).optional(), utilization: z.number().optional(),
    overageStatus: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(), overageResetsAt: z.number().optional(),
    overageDisabledReason: z.string().optional(), isUsingOverage: z.boolean().optional(), overageInUse: z.boolean().optional(),
    overageEnabled: z.boolean().optional(), surpassedThreshold: z.number().optional(),
    limitScope: z.enum(['service', 'channel', 'group_pool']).optional(), errorCode: z.literal('credits_required').optional(),
    canUserPurchaseCredits: z.boolean().optional(), hasChargeableSavedPaymentMethod: z.boolean().optional(),
    observedAt: z.string() }),
  z.strictObject({ kind: z.literal('startup'), id: z.string(), version: z.string().optional(), model: z.string(), cwd: z.string(), tools: z.array(z.string()).max(256),
    permissionMode: z.string(), capabilities: z.array(z.string()).max(256), observedAt: z.string() }),
  z.strictObject({ kind: z.literal('state'), id: z.string(), state: z.enum(['idle', 'running', 'requires_action',
    'compacting', 'requesting', 'shutting_down']), reason: z.string().optional(), observedAt: z.string() }),
  z.strictObject({ kind: z.literal('coverage'), id: z.string(), reason: z.string(), observedAt: z.string() }),
  z.strictObject({ kind: z.literal('result'), id: z.string(), outcome: z.enum(['completed', 'failed', 'interrupted']),
    frame: z.literal('final').optional(), summary: z.string(), terminalReason: z.string().optional(),
    startupFailureReason: z.string().optional(), queuedTurnCount: z.number().int().nonnegative().optional(),
    partial: z.boolean().optional(), observedAt: z.string() }),
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
