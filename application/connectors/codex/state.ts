import type { CallContext, NativeRef, RuntimeTarget } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import type { ConnectorLedger } from '../ledger.ts';
import { bindingSchema, type CodexBinding, type CodexConnection } from './schema.ts';

export class CodexState {
  readonly ledger: ConnectorLedger;
  readonly connection: CodexConnection;
  constructor(ledger: ConnectorLedger, connection: CodexConnection) { this.ledger = ledger; this.connection = connection; }
  reference(kind: string, id: string): NativeRef {
    return { installationId: this.connection.installationId, providerScope: this.connection.directory, kind, id };
  }
  checkInstallation(ctx: CallContext): void {
    if (ctx.installationId !== this.connection.installationId) throw new HubError({ code: 'codex_installation_mismatch',
      category: 'identity_mismatch', message: 'This Codex connection belongs to another installation.', retry: 'never' });
  }
  get(ctx: CallContext, hubSessionId: string): CodexBinding | undefined {
    this.checkInstallation(ctx);
    return this.ledger.get(this.ledger.key(ctx, `binding:${hubSessionId}`), bindingSchema);
  }
  save(ctx: CallContext, hubSessionId: string, binding: CodexBinding): void {
    this.checkInstallation(ctx); this.ledger.put(this.ledger.key(ctx, `binding:${hubSessionId}`), binding);
  }
  target(ctx: CallContext, target: RuntimeTarget, access: 'observe' | 'input' | 'stop' = 'observe'): CodexBinding {
    const binding = this.get(ctx, target.hubSessionId);
    const expected = this.reference('agent-thread', binding?.nativeId ?? '');
    if (!binding || binding.detached || binding.workspaceId !== ctx.workspaceId ||
      JSON.stringify(target.nativeSession) !== JSON.stringify(expected) || target.controlGrantRef !== `codex:${target.hubSessionId}` ||
      (binding.attempt !== undefined && binding.attempt.generation !== target.bindingGeneration)) throw new HubError({
      code: 'codex_binding_mismatch', category: 'identity_mismatch', message: 'The selected Codex thread or binding generation is not current.', retry: 'never' });
    if (access !== 'observe' && (binding.mode !== 'control' || !('authorizedGrantRefs' in ctx) ||
      !Array.isArray(ctx.authorizedGrantRefs) || !ctx.authorizedGrantRefs.includes(target.controlGrantRef))) throw new HubError({ code: 'codex_control_required', category: 'authorization',
      message: 'The current Codex runtime control grant is required for input or interrupt.', retry: 'never' });
    if (access === 'input' && binding.environmentGrant?.expiresAt !== undefined &&
      Date.parse(binding.environmentGrant.expiresAt) <= Date.now()) throw new HubError({ code: 'codex_environment_grant_expired',
      category: 'authorization', message: 'The bound environment use grant expired; Codex input is blocked.', retry: 'manual_action' });
    return binding;
  }
}
