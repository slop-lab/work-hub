import type { CallContext, NativeRef, RuntimeTarget } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import type { ConnectorLedger } from '../ledger.ts';
import { bindingSchema, type Binding, type OpenCodeConnection } from './schema.ts';

export class OpenCodeState {
  readonly ledger: ConnectorLedger;
  readonly connection: OpenCodeConnection;
  constructor(ledger: ConnectorLedger, connection: OpenCodeConnection) {
    this.ledger = ledger; this.connection = connection;
  }
  reference(kind: string, id: string): NativeRef {
    return { installationId: this.connection.installationId,
      providerScope: this.connection.directory, kind, id,
      ...((this.connection.recipient ?? this.connection.environment) === undefined ? {} : {
        incarnation: (this.connection.recipient ?? this.connection.environment)?.incarnation }) };
  }
  get(ctx: CallContext, hubSessionId: string): Binding | undefined {
    this.checkInstallation(ctx);
    return this.ledger.get(this.ledger.key(ctx, `binding:${hubSessionId}`), bindingSchema);
  }
  save(ctx: CallContext, hubSessionId: string, binding: Binding): void {
    this.checkInstallation(ctx);
    this.ledger.put(this.ledger.key(ctx, `binding:${hubSessionId}`), binding);
  }
  checkInstallation(ctx: CallContext): void {
    if (ctx.installationId !== this.connection.installationId) throw new HubError({
      code: 'opencode_installation_mismatch', category: 'identity_mismatch',
      message: 'This runtime connection belongs to another installation.', retry: 'never',
    });
  }
  target(ctx: CallContext, target: RuntimeTarget, access: 'observe' | 'input' | 'stop' = 'observe'): Binding {
    const binding = this.get(ctx, target.hubSessionId);
    const expected = this.reference('agent-session', binding?.nativeId ?? '');
    if (!binding || binding.detached || binding.workspaceId !== ctx.workspaceId ||
      target.nativeSession.installationId !== expected.installationId ||
      target.nativeSession.providerScope !== expected.providerScope ||
      target.nativeSession.kind !== expected.kind || target.nativeSession.id !== expected.id ||
      target.nativeSession.incarnation !== undefined || target.controlGrantRef !== `opencode:${target.hubSessionId}` ||
      (binding.attempt && binding.attempt.generation !== target.bindingGeneration)) throw new HubError({
      code: 'opencode_binding_mismatch', category: 'identity_mismatch',
      message: 'The selected native session or binding generation is not current.', retry: 'never',
    });
    if (access !== 'observe' && (binding.mode !== 'control' ||
      !('authorizedGrantRefs' in ctx) || !Array.isArray(ctx.authorizedGrantRefs) ||
      !ctx.authorizedGrantRefs.includes(target.controlGrantRef))) throw new HubError({ code: 'opencode_control_required',
      category: 'authorization', message: 'The current runtime control grant is required for input or interrupt.', retry: 'never' });
    if (access === 'input' && binding.environmentGrant?.expiresAt !== undefined &&
      Date.parse(binding.environmentGrant.expiresAt) <= Date.now()) throw new HubError({
      code: 'opencode_environment_grant_expired', category: 'authorization',
      message: 'The bound DIM environment use grant expired. Ask its operator to revalidate it. Interrupt remains available.', retry: 'manual_action' });
    return binding;
  }
}
