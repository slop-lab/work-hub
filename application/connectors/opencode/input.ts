import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ActionContext, AttemptStart, CallContext, InputReceipt, InstructionInput, OperationLookup, OperationReceipt } from '../../contracts/index.ts';
import { InputReceiptSchema } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import { digest } from '../../persistence/codec.ts';
import type { OpenCodeClient } from './client.ts';
import { messageSchema, type Binding } from './schema.ts';
import type { OpenCodeState } from './state.ts';

const deliverySchema = z.object({ sessionId: z.string(), messageId: z.string(), textDigest: z.string(), effect: z.string() });
export class OpenCodeInput {
  readonly client: OpenCodeClient;
  readonly state: OpenCodeState;
  constructor(client: OpenCodeClient, state: OpenCodeState) { this.client = client; this.state = state; }

  async validateSelection(ctx: CallContext, binding: Pick<Binding, 'selection'>): Promise<void> {
    const discovery = await this.client.discover(ctx);
    const selection = binding.selection;
    if (!discovery.agents.includes(selection.agent) || !discovery.models.some((model) =>
      model.providerID === selection.model.providerID && model.modelID === selection.model.modelID)) throw new HubError({
      code: 'opencode_selection_unavailable', category: 'requirements_not_met',
      message: 'The saved agent or connected model is unavailable. Refresh discovery and deliberately select an available profile; no automatic substitution was made.',
      retry: 'manual_action',
    });
  }
  async send(ctx: ActionContext, input: AttemptStart | InstructionInput): Promise<OperationReceipt<InputReceipt>> {
    const binding = this.state.target(ctx, input.target, 'input');
    const start = 'input' in input;
    if (!start && input.mode !== 'runtime_queued') throw new HubError({ code: 'opencode_input_mode',
      category: 'unsupported', message: 'This connector supports queued follow-up only.', retry: 'never' });
    if (!start && binding.attempt?.id !== input.target.hubAttemptId) throw new HubError({
      code: 'opencode_attempt_mismatch', category: 'identity_mismatch', message: 'Follow-up targets another attempt.', retry: 'never' });
    if (start && input.workAreas.some((area) => area.path !== this.client.connection.directory)) throw new HubError({
      code: 'opencode_workarea_mismatch', category: 'identity_mismatch', message: 'The configured runtime directory does not match the selected work area.', retry: 'never' });
    if (start && binding.environmentGrant && input.workAreas.some((area) => !binding.environmentGrant?.allowedWorkAreas.some((allowed) =>
      area.key === allowed.key && area.path === allowed.path && area.pathNamespace === allowed.pathNamespace &&
      (area.requestedAccess === 'read' || allowed.requestedAccess === 'write')))) throw new HubError({
      code: 'opencode_workarea_denied', category: 'authorization', message: 'The attempt exceeds its bound environment use grant.', retry: 'never' });
    const text = start ? input.input.instruction : input.text;
    if (start && input.input.promptDigest !== undefined && digest(text) !== input.input.promptDigest) throw new HubError({
      code: 'opencode_prompt_digest_mismatch', category: 'conflict',
      message: 'The rendered handoff prompt digest no longer matches the immutable input snapshot.', retry: 'never',
    });
    const effect = start ? 'attempt.input_received' : 'instruction.accepted_by_runtime';
    return this.state.ledger.execute(ctx, { kind: start ? 'runtime.startAttempt' : 'runtime.sendInstruction',
      schemaId: 'workhub.runtime.input-receipt.v1', schema: InputReceiptSchema, input, effect }, async () => {
      await this.validateSelection(ctx, binding);
      const messageId = `msg_${randomBytes(16).toString('hex')}`;
      this.state.ledger.put(this.state.ledger.key(ctx, `delivery:${ctx.operationId}`), {
        sessionId: binding.nativeId, messageId, textDigest: digest(text), effect,
      });
      this.state.save(ctx, input.target.hubSessionId, { ...binding,
        ownedInputs: [...binding.ownedInputs, { messageId, attemptId: input.target.hubAttemptId,
          executionId: start ? messageId : binding.attempt?.messageId ?? messageId }],
        ...(start ? { attempt: { id: input.target.hubAttemptId, taskId: input.input.taskId,
          generation: input.target.bindingGeneration, messageId, messageIds: [messageId], activitySessions: [] } } : binding.attempt ? {
            attempt: { ...binding.attempt, messageIds: [...binding.attempt.messageIds, messageId] } } : {}),
      });
      await this.client.request(ctx, `/session/${encodeURIComponent(binding.nativeId)}/prompt_async`, {
        messageID: messageId, agent: binding.selection.agent, model: binding.selection.model,
        parts: [{ type: 'text', text }],
      });
      const result = await this.received(ctx, { sessionId: binding.nativeId, messageId, textDigest: digest(text), effect });
      if (!result) throw new HubError({ code: 'opencode_input_unobserved', category: 'unavailable',
        message: 'OpenCode accepted HTTP 204, but the exact user message is not yet observable. Reconcile; do not resend.', retry: 'reconcile_first' });
      return result;
    });
  }
  private async received(ctx: CallContext, delivery: z.infer<typeof deliverySchema>): Promise<InputReceipt | undefined> {
    try {
      const message = messageSchema.parse(await this.client.request(ctx,
        `/session/${encodeURIComponent(delivery.sessionId)}/message/${encodeURIComponent(delivery.messageId)}`));
      if (message.info.id !== delivery.messageId || message.info.sessionID !== delivery.sessionId ||
        message.info.role !== 'user' || digest(message.parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')) !== delivery.textDigest) return undefined;
      return { nativeInputRef: this.state.reference('input', delivery.messageId),
        nativeExecutionRef: this.state.reference('execution', delivery.messageId), acceptance: 'received' };
    } catch (error) {
      if (error instanceof HubError && error.data.code === 'opencode_http_404') return undefined;
      throw error;
    }
  }
  async lookup(ctx: CallContext, operationId: string): Promise<OperationLookup> {
    this.state.checkInstallation(ctx);
    const lookup = this.state.ledger.lookup(ctx, operationId);
    if (lookup.kind === 'found' && lookup.receipt.status === 'unknown') {
      const delivery = this.state.ledger.get(this.state.ledger.key(ctx, `delivery:${operationId}`), deliverySchema);
      if (delivery) {
        const receipt = await this.received(ctx, delivery);
        if (receipt) this.state.ledger.confirm(ctx, operationId, receipt, delivery.effect);
      }
    }
    return this.state.ledger.lookup(ctx, operationId);
  }
}
