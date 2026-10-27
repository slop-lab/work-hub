import { z } from 'zod';
import { EnvironmentUseGrantSchema } from '../../contracts/execution.ts';

const absolutePath = z.string().startsWith('/');
export const codexConnectionSchema = z.strictObject({
  kind: z.literal('codex'), installationId: z.string().min(1), label: z.string().min(1), executable: absolutePath,
  directory: absolutePath, codexHome: absolutePath, modelProvider: z.string().min(1), model: z.string().min(1),
  runtimePath: z.string().min(1).optional(), openaiApiKey: z.string().min(1).optional(),
  environment: z.strictObject({ executionInstallationId: z.string().min(1), hostId: z.string().min(1),
    workspaceId: z.string().min(1), incarnation: z.string().min(1) }).optional(),
});
export type CodexConnection = z.infer<typeof codexConnectionSchema>;

export const codexSelectionSchema = z.strictObject({ agent: z.literal('codex'),
  model: z.strictObject({ providerID: z.string().min(1), modelID: z.string().min(1) }), projectId: z.string().min(1) });
const threadStatusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notLoaded') }), z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('systemError') }), z.object({ type: z.literal('active'), activeFlags: z.array(z.unknown()).optional() }),
]);
export const userMessageSchema = z.object({ type: z.literal('userMessage'), id: z.string(), clientId: z.string().nullable(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough()) });
export const agentMessageSchema = z.object({ type: z.literal('agentMessage'), id: z.string(), text: z.string(),
  phase: z.string().nullable().optional(), questions: z.array(z.unknown()).nullable().optional() });
export const itemSchema = z.object({ type: z.string() }).passthrough();
export const turnSchema = z.object({
  id: z.string(), status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  startedAt: z.number().nullable(), completedAt: z.number().nullable(), error: z.unknown().nullable(), items: z.array(itemSchema),
});
export const threadSchema = z.object({
  id: z.string().uuid(), sessionId: z.string(), ephemeral: z.boolean(), cwd: absolutePath,
  modelProvider: z.string(), model: z.string().nullable(), cliVersion: z.string(), status: threadStatusSchema,
  createdAt: z.number(), updatedAt: z.number(), turns: z.array(turnSchema),
});
export const threadStartResponseSchema = z.object({ thread: threadSchema, model: z.string(), modelProvider: z.string(), cwd: absolutePath });
export const threadReadResponseSchema = z.object({ thread: threadSchema });
export const turnStartResponseSchema = z.object({ turn: turnSchema });
export const modelListResponseSchema = z.object({
  data: z.array(z.object({ id: z.string(), model: z.string(), displayName: z.string(), hidden: z.boolean(), isDefault: z.boolean() })),
  nextCursor: z.string().nullable(),
});
export const threadListResponseSchema = z.object({ data: z.array(threadSchema), nextCursor: z.string().nullable() });
export const accountReadResponseSchema = z.object({ account: z.unknown().nullable(), requiresOpenaiAuth: z.boolean() });
export const bindingSchema = z.object({
  workspaceId: z.string(), nativeId: z.string().uuid(), mode: z.enum(['observe', 'control']), selection: codexSelectionSchema,
  detached: z.boolean(), environmentGrant: EnvironmentUseGrantSchema.nullable(),
  ownedInputs: z.array(z.object({ clientId: z.string(), turnId: z.string(), attemptId: z.string(), textDigest: z.string() })),
  attempt: z.object({ id: z.string(), taskId: z.string(), turnId: z.string(), generation: z.number() }).optional(),
});
export type CodexBinding = z.infer<typeof bindingSchema>;
export type CodexThread = z.infer<typeof threadSchema>;
