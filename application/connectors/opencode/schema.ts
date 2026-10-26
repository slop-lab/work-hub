import { z } from 'zod';
import { EnvironmentUseGrantSchema } from '../../contracts/execution.ts';

export const connectionSchema = z.strictObject({
  installationId: z.string().min(1), label: z.string().min(1),
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash;
  }),
  directory: z.string().startsWith('/'),
  authorization: z.string().min(1),
  nativeUrlTemplate: z.string().optional().refine((template) => {
    if (template === undefined) return true;
    const url = new URL(template.replace('{sessionID}', 'session'));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }),
  environment: z.strictObject({ executionInstallationId: z.string(), hostId: z.string(),
    workspaceId: z.string(), incarnation: z.string() }).optional(),
});
export type OpenCodeConnection = z.infer<typeof connectionSchema>;
export const selectionSchema = z.strictObject({
  agent: z.string().min(1),
  model: z.strictObject({ providerID: z.string().min(1), modelID: z.string().min(1) }),
  projectId: z.string().min(1),
});
export const sessionSchema = z.object({ id: z.string().startsWith('ses'), directory: z.string() });
export const messageSchema = z.object({
  info: z.object({ id: z.string(), sessionID: z.string(), role: z.enum(['user', 'assistant']),
    parentID: z.string().optional(), finish: z.string().optional(), error: z.unknown().optional(),
    time: z.object({ created: z.number(), completed: z.number().optional() }),
  }),
  parts: z.array(z.object({ id: z.string(), type: z.string(), text: z.string().optional() })),
});
export const questionSchema = z.object({
  id: z.string(), sessionID: z.string(),
  tool: z.object({ messageID: z.string(), callID: z.string() }).optional(),
  questions: z.array(z.object({ question: z.string(), header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiple: z.boolean().optional(), custom: z.boolean().optional(),
  })),
});
export const bindingSchema = z.object({
  workspaceId: z.string(), nativeId: z.string(), mode: z.enum(['observe', 'control']),
  selection: selectionSchema, detached: z.boolean().default(false),
  environmentGrant: EnvironmentUseGrantSchema.nullable(),
  ownedInputs: z.array(z.object({ messageId: z.string(), attemptId: z.string(), executionId: z.string() })),
  attempt: z.object({ id: z.string(), taskId: z.string(), messageId: z.string(),
    messageIds: z.array(z.string()), generation: z.number() }).optional(),
});
export type Binding = z.infer<typeof bindingSchema>;
export type NativeMessage = z.infer<typeof messageSchema>;
export type NativeQuestion = z.infer<typeof questionSchema>;
