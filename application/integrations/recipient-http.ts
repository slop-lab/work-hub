import ky from 'ky';
import { JsonValueSchema, type JsonObject, type JsonValue } from '../contracts/common.ts';
import { HubError } from '../domain/errors.ts';

type RecipientRequest = { readonly method: 'GET' | 'POST'; readonly path: string;
  readonly authorization: string; readonly body?: JsonObject };

export class RecipientHttp {
  readonly origin: string;
  readonly limits: { readonly deadlineMs: number; readonly maxBytes: number };
  constructor(origin: string, limits = { deadlineMs: 10_000, maxBytes: 2 * 1024 * 1024 }) {
    this.origin = origin; this.limits = limits;
  }
  async request(input: RecipientRequest): Promise<JsonValue> {
    const controller = new AbortController();
    let completed = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = () => new HubError({ code: 'recipient_deadline', category: 'timeout',
      message: 'Work Hub recipient operation exceeded its deadline.',
      retry: input.method === 'GET' ? 'read_only_retry' : 'reconcile_first' });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(timeout()); }, this.limits.deadlineMs);
    });
    try {
      const operation = (async () => {
        const response = await ky(new URL(input.path, this.origin), { method: input.method,
          headers: { authorization: input.authorization }, ...(input.body === undefined ? {} : { json: input.body }),
          signal: controller.signal, timeout: false, retry: 0, redirect: 'error', throwHttpErrors: false });
        if (!response.ok) throw new HubError({ code: `recipient_http_${response.status}`, category: 'provider_failure',
          message: `Work Hub recipient operation returned HTTP ${response.status}.`, retry: 'manual_action' });
        const declared = Number(response.headers.get('content-length') ?? 0);
        const tooLarge = () => new HubError({ code: 'recipient_body_limit', category: 'provider_failure',
          message: 'Work Hub recipient reply exceeded its bounded response budget.', retry: 'manual_action' });
        if (declared > this.limits.maxBytes) throw tooLarge();
        const reader = response.body?.getReader();
        if (reader === undefined) throw new TypeError('Recipient reply body missing');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > this.limits.maxBytes) throw tooLarge();
            chunks.push(item.value);
          }
        } finally { reader.releaseLock(); }
        return JsonValueSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      })();
      const result = await Promise.race([operation, deadline]);
      completed = true;
      return result;
    } catch (error) {
      if (error instanceof HubError) throw error;
      if (controller.signal.aborted) throw timeout();
      if (error instanceof Error) throw new HubError({ code: 'recipient_transport', category: 'unavailable',
        message: 'Work Hub recipient reply was unavailable or incompatible.',
        retry: input.method === 'GET' ? 'read_only_retry' : 'reconcile_first' });
      throw error;
    } finally {
      clearTimeout(timer);
      if (!completed) controller.abort();
    }
  }
}
