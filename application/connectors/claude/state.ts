import type { CallContext, NativeRef, RuntimeTarget } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import type { ConnectorLedger } from '../ledger.ts';
import { claudeBindingSchema, type ClaudeBinding, type ClaudeConnection } from './schema.ts';

export class ClaudeState {
  readonly ledger: ConnectorLedger;
  readonly connection: ClaudeConnection;
  constructor(ledger: ConnectorLedger, connection: ClaudeConnection) {
    this.ledger = ledger;
    this.connection = connection;
  }

  reference(kind: string, id: string): NativeRef {
    return { installationId: this.connection.installationId, providerScope: this.connection.directory, kind, id };
  }

  checkInstallation(ctx: CallContext): void {
    if (ctx.installationId !== this.connection.installationId) throw new HubError({ code: 'claude_installation_mismatch',
      category: 'identity_mismatch', message: 'This Claude Code connection belongs to another installation.', retry: 'never' });
  }

  get(ctx: CallContext, hubSessionId: string): ClaudeBinding | undefined {
    this.checkInstallation(ctx);
    return this.ledger.get(this.ledger.key(ctx, `binding:${hubSessionId}`), claudeBindingSchema);
  }

  save(ctx: CallContext, hubSessionId: string, binding: ClaudeBinding): void {
    this.checkInstallation(ctx);
    this.ledger.put(this.ledger.key(ctx, `binding:${hubSessionId}`), binding);
  }

  target(ctx: CallContext, target: RuntimeTarget, needsControl = false): ClaudeBinding {
    const binding = this.get(ctx, target.hubSessionId);
    const expected = this.reference('agent-session', binding?.nativeId ?? 'missing');
    if (!binding || binding.detached || binding.workspaceId !== ctx.workspaceId ||
      JSON.stringify(target.nativeSession) !== JSON.stringify(expected) || target.controlGrantRef !== `claude:${target.hubSessionId}` ||
      (binding.attempt !== undefined && binding.attempt.generation !== target.bindingGeneration)) throw new HubError({
      code: 'claude_binding_mismatch', category: 'identity_mismatch',
      message: 'The selected Claude Code session or binding generation is not current.', retry: 'never' });
    if (needsControl && (binding.mode !== 'control' || !('authorizedGrantRefs' in ctx) ||
      !Array.isArray(ctx.authorizedGrantRefs) || !ctx.authorizedGrantRefs.includes(target.controlGrantRef))) throw new HubError({ code: 'claude_control_required',
      category: 'authorization', message: 'The current Claude Code control grant is required.', retry: 'never' });
    if (needsControl && binding.environmentGrant?.expiresAt !== undefined &&
      Date.parse(binding.environmentGrant.expiresAt) <= Date.now()) throw new HubError({ code: 'claude_environment_grant_expired',
      category: 'authorization', message: 'The bound environment use grant expired; input is blocked.', retry: 'manual_action' });
    return binding;
  }
}
