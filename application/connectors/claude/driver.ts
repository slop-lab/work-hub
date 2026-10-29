import { createRequire } from 'node:module';
import type { UUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CanUseTool, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ClaudeConnection, ClaudeMessage, ClaudeSession } from './schema.ts';
import { claudeSessionSchema } from './schema.ts';
import { isClaudeLifecycleFrame, parseClaudeTurnFrame } from './frames.ts';
export { parseClaudeTurnFrame } from './frames.ts';

const CHILD_ENVIRONMENT_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'TERM', 'NO_COLOR', 'CI', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN'] as const;
const SDK_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk' as const;
const MAX_TURN_MESSAGES = 512;
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
    let pendingLifecycle: unknown[] = [];
    for await (const value of stream) {
      const frame = parseClaudeTurnFrame(value, input.inputId, affiliated);
      observedSessionId ??= frame.sessionId;
      if (frame.cleared) pendingLifecycle = [];
      if (!affiliated && !frame.acknowledged && isClaudeLifecycleFrame(value)) pendingLifecycle = [...pendingLifecycle, value].slice(-256);
      if (frame.acknowledged && pendingLifecycle.length > 0) {
        for (const pending of pendingLifecycle) messages.push(...(parseClaudeTurnFrame(pending, input.inputId, true).messages ?? []));
        pendingLifecycle = [];
      }
      affiliated = frame.affiliated;
      inputAcknowledged ||= frame.acknowledged;
      messages.push(...(frame.messages ?? []));
    }
    if (!inputAcknowledged) throw new TypeError('Claude Agent SDK did not attest the exact submitted user message UUID.');
    const boundedMessages: readonly ClaudeMessage[] = messages.length <= MAX_TURN_MESSAGES ? messages : [{
      kind: 'coverage', id: `coverage:${input.inputId}`, reason: 'Claude SDK lifecycle frames exceeded the retained turn limit.',
      observedAt: new Date().toISOString(),
    }, ...messages.slice(-(MAX_TURN_MESSAGES - 1))];
    return { sessionId: observedSessionId ?? input.sessionId, inputId: input.inputId, messages: boundedMessages };
  }
}
