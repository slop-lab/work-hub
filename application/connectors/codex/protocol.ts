import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname } from 'node:path';
import { z } from 'zod';
import { HubError } from '../../domain/errors.ts';
import { BoundedLineDecoder, ProtocolLineLimitError } from './protocol-buffer.ts';
import { threadReadResponseSchema, userMessageSchema, type CodexConnection } from './schema.ts';

const messageSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(),
  result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(), params: z.unknown().optional() });
export type CodexProtocolEvent = { readonly method: string; readonly params: unknown };
export interface CodexProtocol {
  request(method: string, params: unknown): Promise<unknown>;
  version(): Promise<string>;
  trackSubmission(threadId: string, clientId: string): void;
  trackAcceptedTurn(threadId: string, clientId: string, turnId: string): void;
  forgetSubmission(threadId: string, clientId: string): void;
  drainEvents(): readonly CodexProtocolEvent[];
  close(): Promise<void>;
}
type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout };
type TrackedTurn = { readonly threadId: string; readonly clientId: string; readonly turnId?: string };
const MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const MAX_NOTIFICATIONS = 256;

export class CodexProtocolError extends Error {
  readonly code: number;
  constructor(code: number) { super('Codex app-server rejected the request.'); this.name = 'CodexProtocolError'; this.code = code; }
}

export class CodexAppServerProtocol implements CodexProtocol {
  private process: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly events: CodexProtocolEvent[] = [];
  private readonly trackedTurns = new Map<string, TrackedTurn>();
  private readonly connection: CodexConnection;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  constructor(connection: CodexConnection) { this.connection = connection; }

  private environment(): NodeJS.ProcessEnv {
    return { HOME: this.connection.codexHome, CODEX_HOME: this.connection.codexHome,
      PATH: this.connection.runtimePath ?? dirname(process.execPath),
      ...(this.connection.openaiApiKey === undefined ? {} : { OPENAI_API_KEY: this.connection.openaiApiKey }) };
  }
  private async start(): Promise<void> {
    const child = spawn(this.connection.executable, ['app-server', '--stdio'], {
      cwd: this.connection.directory, env: this.environment(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    const decoder = new BoundedLineDecoder(MAX_STDOUT_LINE_BYTES);
    child.stdout.on('data', (chunk: Buffer) => {
      try { for (const line of decoder.push(chunk)) this.receive(line); }
      catch (error) {
        const failure = error instanceof ProtocolLineLimitError
          ? new HubError({ code: 'codex_output_limit', category: 'validation',
            message: 'Codex app-server stdout line exceeded the safe limit.', retry: 'never' })
          : this.transportError();
        this.failTransport(failure);
        child.kill('SIGTERM');
      }
    });
    child.stdout.on('error', () => this.failTransport(this.transportError()));
    child.stderr.on('error', () => undefined);
    child.stderr.resume();
    child.stdin.on('error', () => this.failTransport(this.transportError()));
    child.once('error', () => this.failTransport(new HubError({ code: 'codex_start_failed', category: 'unavailable',
      message: 'Codex app-server could not be started from the configured executable.', retry: 'manual_action' })));
    child.once('exit', () => {
      const error = new HubError({ code: 'codex_app_server_exited', category: 'unavailable',
        message: 'Codex app-server exited. Inspect the scoped installation and authentication state.', retry: 'read_only_retry' });
      this.failTransport(error); this.process = undefined; this.starting = undefined;
    });
    await this.rawRequest('initialize', { clientInfo: { name: 'work-hub', title: 'Work Hub', version: '0.3.0' }, capabilities: null });
    await this.write(child, `${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }
  private transportError(): HubError {
    return new HubError({ code: 'codex_transport_unavailable', category: 'unavailable',
      message: 'Codex app-server transport is unavailable.', retry: 'reconcile_first' });
  }
  private failTransport(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private write(child: ChildProcessWithoutNullStreams, payload: string): Promise<void> {
    return new Promise((resolve, reject) => child.stdin.write(payload, (error) => {
      if (error) reject(this.transportError()); else resolve();
    }));
  }
  private assertAccepting(): void {
    if (this.closing) throw new HubError({ code: 'codex_closing', category: 'unavailable',
      message: 'Codex app-server is closing and accepts no new requests.', retry: 'never' });
  }
  private receive(line: string): void {
    let parsed: z.infer<typeof messageSchema>;
    try { parsed = messageSchema.parse(JSON.parse(line)); }
    catch (error) { if (error instanceof Error) { this.failTransport(this.transportError()); return; } throw error; }
    if (parsed.id !== undefined && parsed.method !== undefined) {
      this.process?.stdin.write(`${JSON.stringify({ id: parsed.id, error: { code: -32601, message: 'Unsupported client request' } })}\n`);
      return;
    }
    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(parsed.id);
      if (parsed.error) pending.reject(new CodexProtocolError(parsed.error.code));
      else pending.resolve(parsed.result);
      return;
    }
    if (parsed.method !== undefined) {
      if (this.events.length === MAX_NOTIFICATIONS) this.events.shift();
      this.events.push({ method: parsed.method, params: parsed.params });
    }
  }
  private rawRequest(method: string, params: unknown): Promise<unknown> {
    const child = this.process;
    if (!child) return Promise.reject(new HubError({ code: 'codex_app_server_unavailable', category: 'unavailable',
      message: 'Codex app-server is unavailable.', retry: 'read_only_retry' }));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HubError({ code: 'codex_timeout', category: 'unavailable',
        message: 'Codex app-server did not answer before the operation deadline.', retry: 'reconcile_first' })); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(id); pending.reject(this.transportError());
      });
    });
  }
  async request(method: string, params: unknown): Promise<unknown> {
    this.assertAccepting();
    this.starting ??= this.start();
    await this.starting;
    return this.rawRequest(method, params);
  }
  async version(): Promise<string> {
    this.assertAccepting();
    return new Promise((resolve, reject) => {
      const child = spawn(this.connection.executable, ['--version'], { cwd: this.connection.directory, env: this.environment(), stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve(output.trim().replace(/^codex-cli\s+/, '')) : reject(new CodexProtocolError(code ?? -1)));
    });
  }
  private trackingKey(threadId: string, clientId: string): string { return JSON.stringify([threadId, clientId]); }
  trackSubmission(threadId: string, clientId: string): void {
    this.assertAccepting();
    this.trackedTurns.set(this.trackingKey(threadId, clientId), { threadId, clientId });
  }
  trackAcceptedTurn(threadId: string, clientId: string, turnId: string): void {
    this.trackedTurns.set(this.trackingKey(threadId, clientId), { threadId, clientId, turnId });
  }
  forgetSubmission(threadId: string, clientId: string): void {
    this.trackedTurns.delete(this.trackingKey(threadId, clientId));
  }
  private async drainTrackedTurns(): Promise<void> {
    while (this.trackedTurns.size > 0) {
      const threadIds = new Set([...this.trackedTurns.values()].map((turn) => turn.threadId));
      for (const threadId of threadIds) {
        const response = threadReadResponseSchema.parse(await this.rawRequest('thread/read', { threadId, includeTurns: true }));
        for (const [key, tracked] of this.trackedTurns) {
          if (tracked.threadId !== threadId) continue;
          const turn = tracked.turnId === undefined ? response.thread.turns.find((candidate) => candidate.items.some((item) => {
            const message = userMessageSchema.safeParse(item);
            return message.success && message.data.clientId === tracked.clientId;
          })) : response.thread.turns.find((candidate) => candidate.id === tracked.turnId);
          if (!turn) continue;
          if (turn.status === 'inProgress') {
            if (tracked.turnId === undefined) this.trackedTurns.set(key, { ...tracked, turnId: turn.id });
          } else this.trackedTurns.delete(key);
        }
      }
      if (this.trackedTurns.size > 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  drainEvents(): readonly CodexProtocolEvent[] { return this.events.splice(0); }
  private async finishClose(): Promise<void> {
    const started = this.starting === undefined ? false : await this.starting.then(() => true, () => false);
    const child = this.process;
    if (!child) return;
    if (started) {
      await this.drainTrackedTurns();
      while (this.pending.size > 0) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
  }
  close(): Promise<void> {
    this.closing = true;
    this.closePromise ??= this.finishClose();
    return this.closePromise;
  }
}
