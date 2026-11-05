import ky from 'ky';
import { z } from 'zod';
import type { ActionContext, AllocationRelease, AllocationRequest, AttachmentRequest, CallContext,
  ConnectorManifest, EnvironmentAttachment, EnvironmentProbe, ExecutionConnector, ExistingEnvironmentRegistration,
  NativeRef, ResourceIdentity } from '../contracts/index.ts';
import { DetachedResultSchema, EnvironmentAttachmentSchema, WorkAreaSchema } from '../contracts/index.ts';
import { HubError } from '../domain/errors.ts';
import type { ConnectorLedger } from './ledger.ts';

export const dimConnectionSchema = z.strictObject({
  installationId: z.string().min(1), label: z.string().min(1),
  endpoint: z.url().refine((value) => { const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    const scopedGateway = url.origin === 'http://127.0.0.1:19420' && url.pathname === '/services/workspace';
    return (url.protocol === 'https:' || url.protocol === 'http:' && loopback) &&
      !url.username && !url.password && (url.pathname === '/' || scopedGateway) && !url.search && !url.hash; }),
  token: z.string().min(1), hostId: z.string().min(1), workspaceId: z.uuid(),
  incarnation: z.string().min(1), displayName: z.string().min(1),
  identityExpiresAt: z.iso.datetime(), runtimeInstallationId: z.string(),
  allowedProjectIds: z.array(z.string()).min(1), workAreas: z.array(WorkAreaSchema).min(1),
});
export type DimConnection = z.infer<typeof dimConnectionSchema>;
const limitations = ['Operator-attested host/workspace incarnation; expires unless the operator revalidates it.',
  'DIM workspace-scoped API does not provide host catalog, allocation, release or incarnation discovery.',
  'Attachment is Hub-local access only; no lifecycle authority or external writer exclusion.'];

export class DimExecutionConnector implements ExecutionConnector {
  readonly connection: DimConnection;
  readonly ledger: ConnectorLedger;
  private readonly verifyDirectory: (ctx: CallContext) => Promise<string>;
  constructor(ledger: ConnectorLedger, connection: DimConnection, verifyDirectory: (ctx: CallContext) => Promise<string>) {
    this.ledger = ledger; this.connection = connection; this.verifyDirectory = verifyDirectory;
  }
  describe(): ConnectorManifest {
    return { id: 'workhub.dim.workspace-scoped', kind: 'execution', implementationVersion: '0.1.0', contractMajor: 1,
      configurationSchemaId: 'workhub.dim.workspace-scoped.v1', requiredSecretPurposes: ['dim-workspace-scoped-http'],
      requiredPermissions: ['workspace.resources.read', 'workspace.plugins.read'], operationSafety: {
        attach: { deduplicatesByClientOperationId: true, lookupByClientOperationId: true, replayAfterUnknown: 'never' },
        detachAttachment: { deduplicatesByClientOperationId: true, lookupByClientOperationId: true, replayAfterUnknown: 'never' },
      }, extensions: { simulated: false, allocate: false, release: false, limitations } };
  }
  private check(ctx: CallContext): void {
    if (ctx.installationId !== this.connection.installationId || Date.parse(this.connection.identityExpiresAt) <= Date.now()) {
      throw new HubError({ code: 'dim_attestation_expired', category: 'identity_mismatch',
        message: 'The DIM connection identity is missing, expired or belongs to another installation. Ask the operator to revalidate its exact incarnation.', retry: 'manual_action' });
    }
  }
  identity(): ResourceIdentity {
    return { native: { installationId: this.connection.installationId, providerScope: this.connection.hostId,
      kind: 'dim-workspace', id: this.connection.workspaceId, incarnation: this.connection.incarnation }, assurance: 'attested' };
  }
  async discover(ctx: CallContext) {
    this.check(ctx);
    const read = async (path: string): Promise<unknown> => {
      try {
        return await ky.get(new URL(path, `${this.connection.endpoint.replace(/\/$/, '')}/`), { headers: { authorization: `Bearer ${this.connection.token}` },
          timeout: 5000, retry: 0, redirect: 'error', ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) }).json<unknown>();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new HubError({ code: 'dim_connection_unavailable', category: 'unavailable',
          message: 'DIM scoped discovery failed. Check the selected workspace connection with its operator; no lifecycle action was attempted.', retry: 'read_only_retry' });
      }
    };
    const [resources, plugins, directory] = await Promise.all([read('v1/resources'), read('v1/plugins'), this.verifyDirectory(ctx)]);
    const safeResources = z.object({ cpuCount: z.string(), memory: z.string(), pidsLimit: z.string() }).parse(resources);
    const safePlugins = z.object({ plugins: z.array(z.object({ name: z.string(), state: z.string() })) }).parse(plugins);
    if (!this.connection.workAreas.every((area) => area.path === directory)) throw new HubError({
      code: 'dim_workdir_mismatch', category: 'identity_mismatch', message: 'The runtime did not verify the registered DIM working directory.', retry: 'never' });
    return { installationId: this.connection.installationId, label: this.connection.label,
      hostId: this.connection.hostId, workspaceId: this.connection.workspaceId, incarnation: this.connection.incarnation,
      displayName: this.connection.displayName, identityExpiresAt: this.connection.identityExpiresAt,
      workAreas: this.connection.workAreas, allowedProjectIds: this.connection.allowedProjectIds,
      resources: safeResources, plugins: safePlugins.plugins, allocate: false, release: false, limitations };
  }
  private observation<T>(ctx: CallContext, value: T) {
    return { value, sourceInstallationId: ctx.installationId, observedAt: new Date().toISOString(),
      assurance: 'reported' as const, limitations };
  }
  async probeExisting(ctx: CallContext, registration: ExistingEnvironmentRegistration) {
    await this.discover(ctx);
    const locator = z.strictObject({ workspaceId: z.string(), hostId: z.string(), incarnation: z.string() }).parse(registration.locator);
    if (locator.workspaceId !== this.connection.workspaceId || locator.hostId !== this.connection.hostId ||
      locator.incarnation !== this.connection.incarnation || registration.executionInstallationId !== ctx.installationId ||
      registration.allowedProjectIds.some((id) => !this.connection.allowedProjectIds.includes(id)) ||
      registration.allowedWorkAreas.some((area) => !this.connection.workAreas.some((allowed) =>
        area.key === allowed.key && area.path === allowed.path && area.pathNamespace === allowed.pathNamespace &&
        (area.requestedAccess === 'read' || allowed.requestedAccess === 'write'))) || registration.allowRuntimeServiceLaunch) {
      throw new HubError({ code: 'dim_registration_mismatch', category: 'identity_mismatch',
        message: 'The registration exceeds the saved DIM connection identity or work-area scope.', retry: 'never' });
    }
    const value: EnvironmentProbe = { identity: this.identity(), observedState: 'running',
      availableWorkAreas: registration.allowedWorkAreas, availableUseGrant: { id: `dim:${registration.id}`,
        allowedWorkAreas: registration.allowedWorkAreas, runtimeServiceLaunch: false, enforcement: 'advisory',
        exclusivity: 'hub_only', expiresAt: this.connection.identityExpiresAt, limitations },
      routeKinds: ['opencode-configured'], unmetRequirements: [] };
    return this.observation(ctx, value);
  }
  async attach(ctx: ActionContext, input: AttachmentRequest) {
    if (input.target.kind !== 'registered_existing') return this.unsupported();
    const probe = await this.probeExisting(ctx, input.target.registration);
    if (!ctx.authorizedGrantRefs.includes(probe.value.availableUseGrant.id)) throw new HubError({
      code: 'dim_use_grant_required', category: 'authorization', message: 'The selected DIM use grant is required to attach.', retry: 'never' });
    if (JSON.stringify(input.target.expectedIdentity) !== JSON.stringify(probe.value.identity) ||
      !this.connection.allowedProjectIds.includes(input.projectId) || input.workAreas.some((area) =>
        !probe.value.availableWorkAreas.some((allowed) => area.key === allowed.key && area.path === allowed.path &&
          area.pathNamespace === allowed.pathNamespace && (input.requestedAccess === 'read' || allowed.requestedAccess === 'write')))) {
      throw new HubError({ code: 'dim_identity_changed', category: 'identity_mismatch', message: 'The DIM identity or selected work area changed.', retry: 'never' });
    }
    return this.ledger.execute<EnvironmentAttachment>(ctx, { kind: 'execution.attach', schemaId: 'workhub.execution.attachment.v1',
      schema: EnvironmentAttachmentSchema, input, effect: 'binding.attached' }, async () => {
      const attachment: EnvironmentAttachment = { hubBindingId: input.hubBindingId, hubBindingGeneration: input.hubBindingGeneration,
        attachmentRef: { ...this.identity().native, kind: 'dim-hub-attachment', id: input.hubBindingId },
        identity: probe.value.identity, origin: 'registered_existing', useGrant: { ...probe.value.availableUseGrant, allowedWorkAreas: [...input.workAreas] },
        routes: [{ id: `dim-runtime:${this.connection.workspaceId}`, ownerInstallationId: ctx.installationId, kind: 'opencode-configured' }] };
      this.ledger.put(this.ledger.key(ctx, `attachment:${input.hubBindingId}`), attachment);
      return attachment;
    });
  }
  async inspectBinding(ctx: CallContext, attachment: EnvironmentAttachment) {
    await this.discover(ctx);
    const saved = this.ledger.get(this.ledger.key(ctx, `attachment:${attachment.hubBindingId}`), EnvironmentAttachmentSchema);
    return this.observation(ctx, { identity: this.identity(), state: 'running' as const,
      attachmentValid: saved !== undefined && JSON.stringify(saved) === JSON.stringify(attachment),
      grantValid: Date.parse(this.connection.identityExpiresAt) > Date.now(), knownExternalActivity: 'unknown' as const, limitations });
  }
  async detachAttachment(ctx: ActionContext, input: { readonly attachmentRef: NativeRef; readonly expectedIdentity: ResourceIdentity }) {
    this.check(ctx);
    return this.ledger.execute<{ readonly detached: true }>(ctx, { kind: 'execution.detachAttachment', schemaId: 'workhub.execution.detached.v1',
      schema: DetachedResultSchema, input, effect: 'binding.detached' }, async () => {
      const key = this.ledger.key(ctx, `attachment:${input.attachmentRef.id}`);
      const saved = this.ledger.get(key, EnvironmentAttachmentSchema);
      if (!saved || JSON.stringify(saved.identity) !== JSON.stringify(input.expectedIdentity) ||
        JSON.stringify(saved.attachmentRef) !== JSON.stringify(input.attachmentRef)) throw new HubError({
        code: 'dim_attachment_mismatch', category: 'identity_mismatch', message: 'Attachment identity mismatch.', retry: 'never' });
      this.ledger.remove(key);
      return { detached: true };
    });
  }
  async lookupOperation(ctx: CallContext, id: string) { this.check(ctx); return this.ledger.lookup(ctx, id); }
  private unsupported(): never { throw new HubError({ code: 'dim_lifecycle_unsupported', category: 'unsupported',
    message: 'This DIM workspace-scoped connection grants no allocation, release or cancellation authority.', retry: 'never' }); }
  async requestAllocation(_ctx: ActionContext, _input: AllocationRequest): Promise<never> { return this.unsupported(); }
  async releaseAllocation(_ctx: ActionContext, _input: AllocationRelease): Promise<never> { return this.unsupported(); }
  async cancelOperation(_ctx: ActionContext, _id: string): Promise<never> { return this.unsupported(); }
}
