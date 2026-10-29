import ky, { HTTPError, TimeoutError } from 'ky';
import { z } from 'zod';
import type { CallContext } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import { messageSchema, questionSchema, sessionSchema, sessionStatusSchema, type OpenCodeConnection } from './schema.ts';

/** Only the trusted backend receives this object. Responses are projected, never proxied. */
export class OpenCodeClient {
  readonly connection: OpenCodeConnection;
  constructor(connection: OpenCodeConnection) { this.connection = connection; }

  async request(ctx: CallContext, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const signal = controller.signal;
    let deadlineExpired = false;
    const timer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, 10_000);
    const interrupted = new Promise<never>((_resolve, reject) => {
      const interrupt = () => reject(new HubError({
        code: deadlineExpired ? 'opencode_timeout' : 'opencode_cancelled', category: 'unavailable',
        message: deadlineExpired ? 'OpenCode exceeded its request/read deadline. Reconcile uncertain input before resending.' :
          'OpenCode request was cancelled. External work may continue; reconcile uncertain input before resending.',
        retry: body === undefined ? 'read_only_retry' : 'reconcile_first',
      }));
      if (signal.aborted) interrupt();
      else signal.addEventListener('abort', interrupt, { once: true });
    });
    const cancel = () => controller.abort();
    ctx.signal?.addEventListener('abort', cancel, { once: true });
    if (ctx.signal?.aborted) cancel();
    let completed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const releaseBody = () => {
      const current = reader;
      reader = undefined;
      if (current) {
        void current.cancel().catch(() => undefined);
        current.releaseLock();
      }
    };
    try {
      if (signal.aborted) return await interrupted;
      const result = await Promise.race([(async () => {
        signal.throwIfAborted();
        const url = new URL(path, this.connection.origin);
        url.searchParams.set('directory', this.connection.directory);
        const response = await ky(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: this.connection.authorization },
          ...(body === undefined ? {} : { json: body }),
          signal,
          timeout: 10_000, retry: 0, redirect: 'error',
        });
        if (response.status === 204) return null;
        reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              signal.throwIfAborted();
              const item = await reader.read();
              if (item.done) break;
              size += item.value.byteLength;
              if (size > 2 * 1024 * 1024) {
                throw new HubError({ code: 'opencode_response_limit', category: 'provider_failure',
                  message: 'OpenCode response exceeds the 2 MiB read budget. Inspect the native session.', retry: 'manual_action' });
              }
              chunks.push(item.value);
            }
          } finally { releaseBody(); }
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      })(), interrupted]);
      completed = true;
      return result;
    } catch (error) {
      if (error instanceof HubError) throw error;
      if (error instanceof HTTPError) {
        void error.response.body?.cancel().catch(() => undefined);
        throw new HubError({
          code: `opencode_http_${error.response.status}`,
          category: error.response.status === 401 ? 'authentication' : 'provider_failure',
          message: `OpenCode returned HTTP ${error.response.status}. Check the saved connection and native session.`,
          retry: body === undefined ? 'read_only_retry' : 'reconcile_first',
        });
      }
      if (error instanceof Error) throw new HubError({
        code: error instanceof TimeoutError ? 'opencode_timeout' : 'opencode_transport', category: 'unavailable',
        message: 'OpenCode is unreachable or returned an incompatible response. Check the scoped connection; do not resend uncertain input.',
        retry: body === undefined ? 'read_only_retry' : 'reconcile_first',
      });
      throw error;
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', cancel);
      if (!completed) controller.abort();
      releaseBody();
    }
  }

  async discover(ctx: CallContext) {
    const [health, path, agents, providers] = await Promise.all([
      this.request(ctx, '/global/health'), this.request(ctx, '/path'),
      this.request(ctx, '/agent'), this.request(ctx, '/config/providers'),
    ]);
    const version = z.object({ healthy: z.literal(true), version: z.string() }).parse(health).version;
    const directory = z.object({ directory: z.string() }).parse(path).directory;
    if (directory !== this.connection.directory) throw new HubError({ code: 'opencode_directory_mismatch',
      category: 'identity_mismatch', message: 'OpenCode did not resolve the selected working directory.', retry: 'manual_action' });
    const inventory = z.object({ providers: z.array(z.object({
      id: z.string(), models: z.record(z.string(), z.unknown()),
    })) }).parse(providers);
    return {
      version, directory,
      agents: z.array(z.object({ name: z.string(), mode: z.string(), hidden: z.boolean().nullish() })).parse(agents)
        .filter((agent) => agent.hidden !== true && agent.mode !== 'subagent').map((agent) => agent.name),
      models: inventory.providers
        .flatMap((provider) => Object.keys(provider.models).map((modelID) => ({ providerID: provider.id, modelID }))),
    };
  }
  async session(ctx: CallContext, id: string) {
    const session = sessionSchema.parse(await this.request(ctx, `/session/${encodeURIComponent(id)}`));
    if (session.id !== id || session.directory !== this.connection.directory) throw new HubError({
      code: 'opencode_session_mismatch', category: 'identity_mismatch',
      message: 'The native session does not belong to the configured working directory.', retry: 'never',
    });
    return session;
  }
  async messages(ctx: CallContext, id: string) {
    return z.array(messageSchema).parse(await this.request(ctx, `/session/${encodeURIComponent(id)}/message?limit=100`));
  }
  async statuses(ctx: CallContext) {
    return z.record(z.string().startsWith('ses'), sessionStatusSchema).parse(await this.request(ctx, '/session/status'));
  }
  async children(ctx: CallContext, id: string) {
    const children = z.array(sessionSchema).parse(await this.request(ctx, `/session/${encodeURIComponent(id)}/children`));
    if (children.some((child) => child.parentID !== id || child.directory !== this.connection.directory)) throw new HubError({
      code: 'opencode_child_mismatch', category: 'identity_mismatch',
      message: 'OpenCode returned a child outside the selected native session or working directory.', retry: 'never',
    });
    return children;
  }
  async questions(ctx: CallContext, id: string) {
    return z.array(questionSchema).parse(await this.request(ctx, '/question')).filter((question) => question.sessionID === id);
  }
}
