import ky, { TimeoutError } from 'ky';
import { HubError } from '../../domain/errors.ts';
import {
  akbContextRequestSchema,
  akbDocumentQuerySchema,
  akbPageListResponseSchema,
  akbPageResponseSchema,
  type AkbConnection,
  type AkbContextRequest,
  type AkbDocumentQuery,
  type AkbPage,
} from './schema.ts';

const responseLimit = 2 * 1024 * 1024;

type AkbRequestOptions = {
  readonly method?: 'get' | 'post';
  readonly json?: AkbContextRequest;
  readonly unavailableCode?: 'akb_page_unavailable' | 'akb_context_unavailable';
  readonly invalidCode?: 'akb_context_invalid';
};

export class AkbClient {
  readonly connection: AkbConnection;

  constructor(connection: AkbConnection) { this.connection = connection; }

  async listPages(parentPageId: string | null): Promise<readonly AkbPage[]> {
    const path = this.path('/pages');
    if (parentPageId !== null) path.searchParams.set('parentPageId', parentPageId);
    const result = akbPageListResponseSchema.safeParse(await this.request(path));
    if (!result.success) throw this.incompatible();
    return result.data.pages.filter((page) => page.workspaceId === this.connection.workspaceId &&
      page.lifecycle === 'active' && this.inScope(page));
  }

  async readPage(pageId: string): Promise<AkbPage> {
    const result = akbPageResponseSchema.safeParse(await this.request(this.path(`/pages/${encodeURIComponent(pageId)}`)));
    if (!result.success) throw this.incompatible();
    const page = result.data.page;
    if (page.id !== pageId || page.workspaceId !== this.connection.workspaceId) throw new HubError({
      code: 'akb_page_identity_mismatch', category: 'identity_mismatch',
      message: 'AKB returned a Page outside the configured workspace identity.', retry: 'never',
    });
    if (!this.inScope(page)) throw new HubError({ code: 'akb_page_outside_scope', category: 'authorization',
      message: 'The AKB Page is outside this configured connection scope.', retry: 'never' });
    if (page.lifecycle === 'archived') throw new HubError({ code: 'akb_page_archived', category: 'conflict',
      message: 'Archived AKB Pages cannot be captured.', retry: 'never' });
    return page;
  }

  async findDocuments(value: AkbDocumentQuery): Promise<never> {
    const query = akbDocumentQuerySchema.parse(value);
    const path = this.path('/documents');
    path.searchParams.set('kind', query.kind);
    path.searchParams.set('query', query.query);
    path.searchParams.set('limit', String(query.limit));
    if (query.afterId !== undefined) path.searchParams.set('afterId', query.afterId);
    await this.request(path);
    throw new HubError({ code: 'akb_document_contract_unavailable', category: 'unsupported',
      message: 'AKB document discovery is disabled until its exact response contract is available.',
      retry: 'manual_action' });
  }

  async readContext(value: AkbContextRequest): Promise<never> {
    const input = akbContextRequestSchema.parse(value);
    await this.request(this.path('/context'), { method: 'post', json: input,
      unavailableCode: 'akb_context_unavailable', invalidCode: 'akb_context_invalid' });
    throw new HubError({ code: 'akb_context_contract_unavailable', category: 'unsupported',
      message: 'AKB context capture is disabled until its exact response contract is available.',
      retry: 'manual_action' });
  }

  private path(suffix: string): URL {
    return new URL(`/api/content/v1/workspaces/${encodeURIComponent(this.connection.workspaceId)}${suffix}`,
      this.connection.origin);
  }

  private inScope(page: AkbPage): boolean {
    return this.connection.allowedPageIds.includes(page.id) ||
      (page.spaceId !== null && this.connection.allowedSpaceIds.includes(page.spaceId));
  }

  private incompatible(): HubError {
    return new HubError({ code: 'akb_incompatible_response', category: 'provider_failure',
      message: 'AKB returned an incompatible content response.', retry: 'manual_action' });
  }

  private async request(url: URL, options: AkbRequestOptions = {}): Promise<unknown> {
    const controller = new AbortController();
    let completed = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = () => new HubError({ code: 'akb_timeout', category: 'unavailable',
      message: 'AKB did not complete the read before its operation deadline.', retry: 'read_only_retry' });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(timeout()); }, 10_000);
    });
    try {
      const operation = (async () => {
       const response = await ky(url, { method: options.method ?? 'get',
         ...(options.json === undefined ? {} : { json: options.json }),
         headers: { authorization: this.connection.authorization }, timeout: false,
         signal: controller.signal,
         retry: 0, redirect: 'error', throwHttpErrors: false });
      if (response.status === 401) throw new HubError({ code: 'akb_authentication_failed', category: 'authentication',
        message: 'AKB rejected the configured backend credential.', retry: 'manual_action' });
       if (response.status === 403 || response.status === 404) throw new HubError({
         code: options.unavailableCode ?? 'akb_page_unavailable', category: 'authorization',
         message: options.unavailableCode === 'akb_context_unavailable'
           ? 'The selected AKB context is missing, revoked, or unreadable.'
           : 'The AKB Page is missing, revoked, or unreadable.', retry: 'never' });
       if (response.status === 422 && options.invalidCode !== undefined) throw new HubError({
         code: options.invalidCode, category: 'validation',
         message: 'AKB rejected the context selection or byte budget.', retry: 'never' });
      if (!response.ok) throw new HubError({ code: `akb_http_${response.status}`, category: 'provider_failure',
        message: `AKB returned HTTP ${response.status}.`, retry: 'read_only_retry' });
      return JSON.parse(await readBounded(response));
      })();
      const value: unknown = await Promise.race([operation, deadline]);
      completed = true;
      return value;
    } catch (error) {
      if (error instanceof HubError) throw error;
      if (controller.signal.aborted) throw timeout();
      if (error instanceof SyntaxError) throw new HubError({ code: 'akb_incompatible_response', category: 'provider_failure',
        message: 'AKB returned an incompatible JSON response.', retry: 'manual_action' });
      if (error instanceof Error) throw new HubError({ code: error instanceof TimeoutError ? 'akb_timeout' : 'akb_transport',
        category: 'unavailable', message: 'AKB is unreachable or did not complete the read.', retry: 'read_only_retry' });
      throw error;
    } finally {
      clearTimeout(timer);
      if (!completed) controller.abort();
    }
  }
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > responseLimit) throw new HubError({ code: 'akb_response_limit', category: 'provider_failure',
    message: 'AKB response exceeds the 2 MiB read budget.', retry: 'manual_action' });
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > responseLimit) throw new HubError({ code: 'akb_response_limit', category: 'provider_failure',
        message: 'AKB response exceeds the 2 MiB read budget.', retry: 'manual_action' });
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
