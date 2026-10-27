import type { Actor } from '../../domain/authorization.ts';
import { HubError } from '../../domain/errors.ts';
import type { AkbClient } from './client.ts';
import { renderAkbPage } from './render.ts';

export type AkbCaptureInput = {
  readonly commandId: string;
  readonly taskId: string;
  readonly installationId: string;
  readonly pageId: string;
  readonly revision: number;
};

export type ExternalReferenceCapture = {
  readonly commandId: string;
  readonly taskId: string;
  readonly title: string;
  readonly retainedText: string;
  readonly mimeType: string;
  readonly sourceRevision: string;
  readonly provenance: Readonly<Record<string, string | number | boolean | null>>;
} & AkbCaptureInput;

export type ReferenceReceipt = { readonly kind: 'reference'; readonly id: string; readonly revision: 1 };
export type ExternalCaptureRequest = AkbCaptureInput | ExternalReferenceCapture;

export class AkbContextService {
  readonly clients: Readonly<Record<string, AkbClient>>;
  private readonly captureReference: (actor: Actor, input: ExternalCaptureRequest) => ReferenceReceipt | undefined;
  private readonly taskProject: (actor: Actor, taskId: string) => string;

  constructor(clients: Readonly<Record<string, AkbClient>>,
    captureReference: (actor: Actor, input: ExternalCaptureRequest) => ReferenceReceipt | undefined,
    taskProject: (actor: Actor, taskId: string) => string) {
    this.clients = clients;
    this.captureReference = captureReference;
    this.taskProject = taskProject;
  }

  connections(actor: Actor, projectId: string): readonly { readonly installationId: string; readonly label: string }[] {
    return Object.entries(this.clients).filter(([, client]) => this.visible(client, actor, projectId))
      .map(([installationId, client]) => ({ installationId, label: client.connection.label }));
  }

  async list(actor: Actor, projectId: string, installationId: string, parentPageId: string | null) {
    return this.client(actor, projectId, installationId).listPages(parentPageId);
  }

  async read(actor: Actor, projectId: string, installationId: string, pageId: string) {
    return this.client(actor, projectId, installationId).readPage(pageId);
  }

  async capture(actor: Actor, input: AkbCaptureInput): Promise<ReferenceReceipt> {
    if (actor.role !== 'administrator' && actor.role !== 'member') throw new HubError({
      code: 'akb_human_principal_required', category: 'authorization',
      message: 'Only a human principal can capture AKB context.', retry: 'never',
    });
    const projectId = this.taskProject(actor, input.taskId);
    const existing = this.captureReference(actor, input);
    if (existing !== undefined) return existing;
    const client = this.client(actor, projectId, input.installationId);
    const page = await client.readPage(input.pageId);
    if (page.revision !== input.revision) throw new HubError({ code: 'akb_revision_changed', category: 'conflict',
      message: 'The AKB Page changed after selection. Review the current revision before capturing it.', retry: 'never',
      details: { selectedRevision: input.revision, currentRevision: page.revision } });
    const retainedText = renderAkbPage(page);
    if (Buffer.byteLength(retainedText) > 131_072) throw new HubError({ code: 'akb_page_too_large', category: 'validation',
      message: 'The AKB Page exceeds the 128 KiB immutable context budget.', retry: 'never' });
    const captured = this.captureReference(actor, { ...input,
      title: page.title, retainedText,
      mimeType: 'text/plain', sourceRevision: String(page.revision), provenance: {
        provider: 'akb', installationId: input.installationId, workspaceId: page.workspaceId,
        pageId: page.id, revision: page.revision, sourceUpdatedAt: page.updatedAt,
      } });
    if (captured === undefined) throw new TypeError('AKB capture commit returned no reference receipt.');
    return captured;
  }

  private client(actor: Actor, projectId: string, installationId: string): AkbClient {
    const client = this.clients[installationId];
    if (client === undefined || !this.visible(client, actor, projectId)) throw new HubError({
      code: 'akb_connection_unavailable', category: 'authorization',
      message: 'The selected AKB connection is unavailable.', retry: 'never' });
    return client;
  }

  private visible(client: AkbClient, actor: Actor, projectId: string): boolean {
    const actorCanReadProject = actor.role === 'administrator' || actor.projectIds.includes(projectId);
    return actorCanReadProject && actor.workspaceId === client.connection.workHubWorkspaceId &&
      client.connection.allowedProjectIds.includes(projectId);
  }
}
