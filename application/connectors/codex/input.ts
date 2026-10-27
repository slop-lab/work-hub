import { z } from 'zod';
import type { ActionContext, AttemptStart, CallContext, InputReceipt, InstructionInput, OperationLookup, OperationReceipt } from '../../contracts/index.ts';
import { InputReceiptSchema } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import { digest } from '../../persistence/codec.ts';
import { CodexProtocolError, type CodexProtocol } from './protocol.ts';
import { threadReadResponseSchema, turnStartResponseSchema, userMessageSchema } from './schema.ts';
import type { CodexState } from './state.ts';

const deliverySchema = z.object({ hubSessionId: z.string(), threadId: z.string(), clientId: z.string(), attemptId: z.string(),
  taskId: z.string(), generation: z.number(), textDigest: z.string(), effect: z.string() });
export class CodexInput {
  private readonly protocol: CodexProtocol;
  private readonly state: CodexState;
  constructor(protocol: CodexProtocol, state: CodexState) { this.protocol = protocol; this.state = state; }
  async send(ctx: ActionContext, input: AttemptStart | InstructionInput): Promise<OperationReceipt<InputReceipt>> {
    const binding = this.state.target(ctx, input.target, 'input');
    const start = 'input' in input;
    if (!start && input.mode !== 'runtime_queued') throw new HubError({ code: 'codex_input_mode', category: 'unsupported',
      message: 'Codex follow-up input is accepted only through the runtime queue.', retry: 'never' });
    if (!start && binding.attempt?.id !== input.target.hubAttemptId) throw new HubError({ code: 'codex_attempt_mismatch',
      category: 'identity_mismatch', message: 'The follow-up targets another attempt.', retry: 'never' });
    if (start && input.workAreas.some((area) => area.path !== this.state.connection.directory)) throw new HubError({
      code: 'codex_workarea_mismatch', category: 'identity_mismatch', message: 'The configured Codex directory does not match the selected work area.', retry: 'never' });
    if (start && binding.environmentGrant && input.workAreas.some((area) => !binding.environmentGrant?.allowedWorkAreas.some((allowed) =>
      area.key === allowed.key && area.path === allowed.path && area.pathNamespace === allowed.pathNamespace &&
      (area.requestedAccess === 'read' || allowed.requestedAccess === 'write')))) throw new HubError({
      code: 'codex_workarea_denied', category: 'authorization', message: 'The attempt exceeds its bound environment use grant.', retry: 'never' });
    const text = start ? JSON.stringify(input.input) : input.text;
    const effect = start ? 'attempt.input_received' : 'instruction.accepted_by_runtime';
    const delivery = { hubSessionId: input.target.hubSessionId, threadId: binding.nativeId, clientId: `workhub:${ctx.operationId}`,
      attemptId: input.target.hubAttemptId, taskId: start ? input.input.taskId : binding.attempt?.taskId ?? '',
      generation: input.target.bindingGeneration, textDigest: digest(text), effect };
    return this.state.ledger.execute(ctx, { kind: start ? 'runtime.startAttempt' : 'runtime.sendInstruction',
      schemaId: 'workhub.runtime.input-receipt.v1', schema: InputReceiptSchema, input, effect }, async () => {
      this.state.ledger.put(this.state.ledger.key(ctx, `delivery:${ctx.operationId}`), delivery);
      this.protocol.trackSubmission(binding.nativeId, delivery.clientId);
      let response: z.infer<typeof turnStartResponseSchema>;
      try {
        response = turnStartResponseSchema.parse(await this.protocol.request('turn/start', {
          threadId: binding.nativeId, clientUserMessageId: delivery.clientId, input: [{ type: 'text', text, text_elements: [] }],
        }));
      } catch (error) {
        if (error instanceof CodexProtocolError) this.protocol.forgetSubmission(binding.nativeId, delivery.clientId);
        throw error;
      }
      this.protocol.trackAcceptedTurn(binding.nativeId, delivery.clientId, response.turn.id);
      this.record(ctx, binding, delivery, response.turn.id);
      return { nativeInputRef: this.state.reference('input', delivery.clientId),
        nativeExecutionRef: this.state.reference('turn', response.turn.id), acceptance: 'received' };
    });
  }
  private record(ctx: CallContext, binding: ReturnType<CodexState['target']>, delivery: z.infer<typeof deliverySchema>, turnId: string): void {
    this.state.save(ctx, delivery.hubSessionId, { ...binding,
      ownedInputs: [...binding.ownedInputs, { clientId: delivery.clientId, turnId, attemptId: delivery.attemptId, textDigest: delivery.textDigest }],
      attempt: { id: delivery.attemptId, taskId: delivery.taskId, turnId, generation: delivery.generation } });
  }
  async lookup(ctx: CallContext, operationId: string): Promise<OperationLookup> {
    this.state.checkInstallation(ctx);
    const lookup = this.state.ledger.lookup(ctx, operationId);
    if (lookup.kind !== 'found' || lookup.receipt.status !== 'unknown') return lookup;
    const delivery = this.state.ledger.get(this.state.ledger.key(ctx, `delivery:${operationId}`), deliverySchema);
    if (!delivery) return lookup;
    const response = threadReadResponseSchema.parse(await this.protocol.request('thread/read', { threadId: delivery.threadId, includeTurns: true }));
    const turn = response.thread.turns.find((candidate) => candidate.items.some((item) => {
      const message = userMessageSchema.safeParse(item);
      return message.success && message.data.clientId === delivery.clientId &&
        digest(message.data.content.map((content) => content.text).join('')) === delivery.textDigest;
    }));
    if (!turn) return lookup;
    const binding = this.state.get(ctx, delivery.hubSessionId);
    if (!binding) return lookup;
    this.record(ctx, binding, delivery, turn.id);
    const receipt = { nativeInputRef: this.state.reference('input', delivery.clientId), nativeExecutionRef: this.state.reference('turn', turn.id), acceptance: 'received' as const };
    this.state.ledger.confirm(ctx, operationId, receipt, delivery.effect);
    return this.state.ledger.lookup(ctx, operationId);
  }
}
