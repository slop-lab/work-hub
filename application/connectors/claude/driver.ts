import { createRequire } from 'node:module';
import type { UUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CanUseTool, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ClaudeConnection, ClaudeMessage, ClaudeSession } from './schema.ts';
import { claudeSessionSchema } from './schema.ts';

const CHILD_ENVIRONMENT_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'TERM', 'NO_COLOR', 'CI', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN'] as const;
const SDK_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk' as const;
const packageMetadataSchema = z.object({ version: z.string().min(1) });

export function buildClaudeChildEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(CHILD_ENVIRONMENT_KEYS.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

export async function installedClaudeSdkVersion(): Promise<string> {
  const entry = createRequire(import.meta.url).resolve(SDK_PACKAGE_NAME);
  const raw: unknown = JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8'));
  return packageMetadataSchema.parse(raw).version;
}

export interface ClaudeSdkDriver {
  discover(signal?: AbortSignal): Promise<{ readonly version: string; readonly sessions: readonly ClaudeSession[] }>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<ClaudeSession | undefined>;
  run(input: { readonly sessionId: string; readonly inputId: UUID; readonly prompt: string; readonly model: string;
    readonly signal?: AbortSignal }): Promise<{ readonly sessionId: string; readonly inputId: UUID;
      readonly messages: readonly ClaudeMessage[] }>;
}

const rawSessionSchema = z.object({ sessionId: z.string(), summary: z.string().optional(), cwd: z.string().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(), lastModified: z.union([z.string(), z.number()]).optional() });
const rawMessageSchema = z.object({ type: z.string(), session_id: z.string().optional(), uuid: z.string().optional(),
  subtype: z.string().optional(), result: z.string().optional(), is_error: z.boolean().optional(),
  user_message_uuid: z.string().optional(), user_message_uuids: z.array(z.string()).optional(),
  parent_tool_use_id: z.string().nullable().optional(), timestamp: z.string().optional(),
  message: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).optional() }).passthrough();

export type ClaudeTurnFrame = { readonly affiliated: boolean; readonly acknowledged: boolean;
  readonly message?: ClaudeMessage };

export function parseClaudeTurnFrame(value: unknown, inputId: string, affiliated: boolean): ClaudeTurnFrame {
  const parsed = rawMessageSchema.parse(value);
  const echoesInput = parsed.user_message_uuid === inputId || parsed.user_message_uuids?.includes(inputId) === true;
  const identifiesInput = parsed.user_message_uuid !== undefined || parsed.user_message_uuids !== undefined;
  const retainedAffiliation = identifiesInput && !echoesInput ? false : affiliated;
  const observedAt = parsed.timestamp ?? new Date().toISOString();
  if (parsed.type === 'assistant') {
    const mainThread = parsed.parent_tool_use_id === null;
    const nextAffiliated = retainedAffiliation || (mainThread && echoesInput);
    const text = parsed.message?.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n') ?? '';
    return { affiliated: nextAffiliated, acknowledged: mainThread && echoesInput,
      ...(mainThread && nextAffiliated && text ? {
        message: { kind: 'assistant' as const, id: parsed.uuid ?? 'assistant:unknown', text, observedAt },
      } : {}) };
  }
  if (parsed.type === 'result') {
    const linked = retainedAffiliation || echoesInput;
    return { affiliated: false, acknowledged: echoesInput, ...(linked ? { message: {
      kind: 'result' as const, id: parsed.uuid ?? 'result:unknown',
      outcome: parsed.subtype === 'success' && parsed.is_error !== true ? 'completed' as const : 'failed' as const,
      summary: parsed.result ?? '', observedAt,
    } } : {}) };
  }
  return { affiliated: retainedAffiliation, acknowledged: false };
}

export const denyClaudePermission: CanUseTool = async (_toolName, _input, options) => ({
  behavior: 'deny', message: 'Use authenticated Claude Code for native permission decisions.',
  toolUseID: options.toolUseID,
});

function timestamp(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return new Date(value).toISOString();
}

function session(value: unknown): ClaudeSession {
  const parsed = rawSessionSchema.parse(value);
  return claudeSessionSchema.parse({ sessionId: parsed.sessionId, summary: parsed.summary, cwd: parsed.cwd,
    createdAt: timestamp(parsed.createdAt), lastModified: timestamp(parsed.lastModified) });
}

export class OfficialClaudeSdkDriver implements ClaudeSdkDriver {
  private readonly connection: ClaudeConnection;
  constructor(connection: ClaudeConnection) { this.connection = connection; }

  private sdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
    return import('@anthropic-ai/claude-agent-sdk');
  }

  async discover(_signal?: AbortSignal) {
    const sdk = await this.sdk();
    const values = z.array(z.unknown()).parse(await sdk.listSessions({ dir: this.connection.directory, limit: 100 }));
    return { version: await installedClaudeSdkVersion(), sessions: values.map(session) };
  }

  async getSession(sessionId: string, _signal?: AbortSignal): Promise<ClaudeSession | undefined> {
    const sdk = await this.sdk();
    const value: unknown = await sdk.getSessionInfo(sessionId, { dir: this.connection.directory });
    return value === null || value === undefined ? undefined : session(value);
  }

  async run(input: { readonly sessionId: string; readonly inputId: UUID; readonly prompt: string; readonly model: string;
    readonly signal?: AbortSignal }) {
    const sdk = await this.sdk();
    const abortController = new AbortController();
    input.signal?.addEventListener('abort', () => abortController.abort(input.signal?.reason), { once: true });
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', session_id: input.sessionId, parent_tool_use_id: null, uuid: input.inputId,
        client_composed: true, message: { role: 'user', content: input.prompt } };
    })();
    const options = { cwd: this.connection.directory, resume: input.sessionId,
      model: input.model, permissionMode: 'default', canUseTool: denyClaudePermission, settingSources: [],
      env: buildClaudeChildEnvironment(process.env),
      ...(this.connection.executablePath === undefined ? {} : { pathToClaudeCodeExecutable: this.connection.executablePath }),
      abortController } satisfies Options;
    const stream = sdk.query({ prompt, options });
    const messages: ClaudeMessage[] = [];
    let observedSessionId: string | undefined;
    let inputAcknowledged = false;
    let affiliated = false;
    for await (const value of stream) {
      const parsed = rawMessageSchema.parse(value);
      observedSessionId ??= parsed.session_id;
      const frame = parseClaudeTurnFrame(value, input.inputId, affiliated);
      affiliated = frame.affiliated;
      inputAcknowledged ||= frame.acknowledged;
      if (frame.message) messages.push(frame.message);
    }
    if (!inputAcknowledged) throw new TypeError('Claude Agent SDK did not attest the exact submitted user message UUID.');
    return { sessionId: observedSessionId ?? input.sessionId, inputId: input.inputId, messages };
  }
}
