import ky, { TimeoutError } from 'ky';
import { HubError } from '../../domain/errors.ts';
import { akbDocumentsResponseSchema, akbKnowledgeRevisionSchema,
  type AkbDocumentsResponse, type AkbContextResponse } from './context-schema.ts';
import { akbSourceAllowed, assertAkbSources, validateAkbContext } from './context-validation.ts';
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
  readonly unavailableCode?: 'akb_page_unavailable' | 'akb_context_unavailable' | 'akb_source_unavailable';
  readonly invalidCode?: 'akb_context_invalid';
};

export class AkbClient {
  readonly connection: AkbConnection;

  constructor(connection: AkbConnection) { this.connection = connection; }

  async listPages(parentPageId: string | null): Promise<readonly AkbPage[]> {
    if (this.connection.allowedPageIds.length === 0 && this.connection.allowedSpaceIds.length === 0) {
      throw new HubError({ code: 'akb_page_outside_scope', category: 'authorization',
        message: 'No Page scope is configured for this AKB connection.', retry: 'never' });
    }
    const path = this.path('/pages');
    if (parentPageId !== null) path.searchParams.set('parentPageId', parentPageId);
    const result = akbPageListResponseSchema.safeParse(await this.request(path));
    if (!result.success) throw this.incompatible();
    return result.data.pages.filter((page) => page.workspaceId === this.connection.workspaceId &&
      page.lifecycle === 'active' && this.inScope(page));
  }

  async readPage(pageId: string): Promise<AkbPage> {
    if (!this.connection.allowedPageIds.includes(pageId) && this.connection.allowedSpaceIds.length === 0) {
      throw new HubError({ code: 'akb_page_outside_scope', category: 'authorization',
        message: 'The AKB Page is outside the configured explicit Page scope.', retry: 'never' });
    }
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

  async readPageRevision(pageId: string, revision: number): Promise<AkbPage> {
    if (!this.connection.allowedPageIds.includes(pageId)) throw new HubError({ code: 'akb_source_outside_scope',
      category: 'authorization', message: 'The pinned AKB Page is outside the explicit source allowlist.', retry: 'never' });
    const result = akbPageResponseSchema.pick({ page: true }).safeParse(await this.request(
      this.path(`/pages/${encodeURIComponent(pageId)}/revisions/${revision}`)));
    if (!result.success) throw this.incompatible();
    const page = result.data.page;
    if (page.id !== pageId || page.workspaceId !== this.connection.workspaceId || page.revision !== revision ||
      page.lifecycle !== 'active') throw new HubError({ code: 'akb_page_identity_mismatch', category: 'identity_mismatch',
        message: 'AKB returned a different exact Page identity or revision.', retry: 'never' });
    return page;
  }

  async findDocuments(value: AkbDocumentQuery): Promise<AkbDocumentsResponse> {
    const query = akbDocumentQuerySchema.parse(value);
    if (query.kind === 'page' ? this.connection.allowedPageIds.length === 0 : this.connection.allowedKnowledgeIds.length === 0) {
      throw new HubError({ code: 'akb_source_outside_scope', category: 'authorization',
        message: 'No explicit source allowlist is configured for this document kind.', retry: 'never' });
    }
    let cursor = query.afterId || undefined;
    if (cursor !== undefined && !akbSourceAllowed(this.connection, { kind: query.kind, id: cursor })) {
      throw new HubError({ code: 'akb_source_outside_scope', category: 'authorization',
        message: 'The document cursor is outside the explicit source allowlist.', retry: 'never' });
    }
    const visible: AkbDocumentsResponse['items'] = [];
    const seen = new Set<string>(cursor === undefined ? [] : [cursor]);
    for (let page = 0; page < 8; page += 1) {
      const path = this.path('/documents');
      path.searchParams.set('kind', query.kind);
      path.searchParams.set('query', query.query);
      path.searchParams.set('limit', String(query.limit));
      if (cursor !== undefined) path.searchParams.set('afterId', cursor);
      const parsed = akbDocumentsResponseSchema.safeParse(await this.request(path,
        { unavailableCode: 'akb_source_unavailable' }));
      if (!parsed.success || parsed.data.items.some((item) => item.kind !== query.kind) ||
        parsed.data.items.length > query.limit) throw this.incompatible();
      for (const item of parsed.data.items) {
        if (akbSourceAllowed(this.connection, item) && !visible.some((existing) => existing.id === item.id)) visible.push(item);
      }
      if (visible.length > query.limit) return { items: visible.slice(0, query.limit),
        nextAfterId: visible[query.limit - 1]?.id ?? null, consistency: 'live' };
      if (parsed.data.nextAfterId === null) return { items: visible, nextAfterId: null, consistency: 'live' };
      cursor = parsed.data.nextAfterId;
      if (seen.has(cursor)) throw this.incompatible();
      seen.add(cursor);
    }
    throw new HubError({ code: 'akb_discovery_coverage_limited', category: 'requirements_not_met',
      message: 'Narrow the document query to complete bounded allowlist-filtered discovery.', retry: 'manual_action' });
  }

  async readKnowledgeRevision(id: string, revision: number) {
    if (!this.connection.allowedKnowledgeIds.includes(id)) throw new HubError({ code: 'akb_source_outside_scope',
      category: 'authorization', message: 'The AKB Knowledge object is outside the explicit source allowlist.', retry: 'never' });
    const url = new URL(`/api/knowledge/v1/workspaces/${encodeURIComponent(this.connection.workspaceId)}` +
      `/objects/${encodeURIComponent(id)}/revisions/${revision}`, this.connection.origin);
    const parsed = akbKnowledgeRevisionSchema.safeParse(await this.request(url,
      { unavailableCode: 'akb_source_unavailable' }));
    if (!parsed.success) throw this.incompatible();
    if (parsed.data.id !== id || parsed.data.revision !== revision || parsed.data.lifecycle !== 'active') {
      throw new HubError({ code: 'akb_context_identity_mismatch', category: 'identity_mismatch',
        message: 'AKB returned a different exact Knowledge identity or revision.', retry: 'never' });
    }
    return parsed.data;
  }

  async readContext(value: AkbContextRequest): Promise<AkbContextResponse> {
    const input = akbContextRequestSchema.parse(value);
    assertAkbSources(this.connection, input);
    const raw = await this.request(this.path('/context'), { method: 'post', json: input,
      unavailableCode: 'akb_context_unavailable', invalidCode: 'akb_context_invalid' });
    return validateAkbContext(raw, input, this.connection.workspaceId);
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
            : options.unavailableCode === 'akb_source_unavailable'
              ? 'The selected AKB source is missing, revoked, or unreadable.'
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
