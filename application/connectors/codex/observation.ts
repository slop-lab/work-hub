import type { CallContext, ExecutionObservation, OutputItem, OutputPage, RuntimeEvent, RuntimeSessionObservation, RuntimeTarget } from '../../contracts/index.ts';
import { digest } from '../../persistence/codec.ts';
import type { CodexProtocol } from './protocol.ts';
import { agentMessageSchema, threadReadResponseSchema, userMessageSchema, type CodexBinding, type CodexThread } from './schema.ts';
import type { CodexState } from './state.ts';

const LIMITATIONS = [
  'Native approvals and questions require an authenticated native Codex client.',
  'Only Hub-owned turns and completed user/agent messages are imported; tool activity and unrelated history remain native.',
  'A turn response proves input receipt, not successful execution or task completion.',
] as const;

function execution(state: CodexState, binding: CodexBinding, thread: CodexThread): ExecutionObservation {
  const attempt = binding.attempt;
  if (!attempt) return { phase: thread.status.type === 'idle' ? 'idle' : 'unknown', pendingNativeRequestRefs: [] };
  const turn = thread.turns.find((candidate) => candidate.id === attempt.turnId);
  const common = { hubAttemptId: attempt.id, nativeExecutionRef: state.reference('turn', attempt.turnId), pendingNativeRequestRefs: [] };
  if (!turn) return { ...common, phase: 'unknown' };
  switch (turn.status) {
    case 'inProgress': return { ...common, phase: 'running', ...(turn.startedAt === null ? {} : { startedAt: new Date(turn.startedAt * 1000).toISOString() }) };
    case 'completed': return { ...common, phase: 'ended', termination: 'completed', ...(turn.completedAt === null ? {} : { endedAt: new Date(turn.completedAt * 1000).toISOString() }) };
    case 'interrupted': return { ...common, phase: 'ended', termination: 'stopped', ...(turn.completedAt === null ? {} : { endedAt: new Date(turn.completedAt * 1000).toISOString() }) };
    case 'failed': return { ...common, phase: 'ended', termination: 'failed', ...(turn.completedAt === null ? {} : { endedAt: new Date(turn.completedAt * 1000).toISOString() }) };
  }
}

export class CodexObservation {
  private readonly protocol: CodexProtocol;
  private readonly state: CodexState;
  constructor(protocol: CodexProtocol, state: CodexState) { this.protocol = protocol; this.state = state; }
  private async thread(ctx: CallContext, target: RuntimeTarget): Promise<{ readonly binding: CodexBinding; readonly thread: CodexThread }> {
    const binding = this.state.target(ctx, target);
    const response = threadReadResponseSchema.parse(await this.protocol.request('thread/read', { threadId: binding.nativeId, includeTurns: true }));
    return { binding, thread: response.thread };
  }
  async inspect(ctx: CallContext, target: RuntimeTarget): Promise<RuntimeSessionObservation> {
    const { binding, thread } = await this.thread(ctx, target);
    return { nativeSession: target.nativeSession, exists: true, execution: execution(this.state, binding, thread),
      controlGrantValid: !binding.detached, limitations: [...LIMITATIONS] };
  }
  async output(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string; readonly limit: number }): Promise<OutputPage> {
    const { binding, thread } = await this.thread(ctx, input.target);
    const owned = new Map(binding.ownedInputs.map((item) => [item.turnId, item]));
    const items: OutputItem[] = [];
    for (const turn of thread.turns) {
      const association = owned.get(turn.id);
      if (!association || turn.status === 'inProgress') continue;
      for (const item of turn.items) {
        const user = userMessageSchema.safeParse(item);
        if (user.success) items.push({ sourceItemId: user.data.id, nativeExecutionRef: this.state.reference('turn', turn.id),
          hubAttemptId: association.attemptId, kind: 'message' as const, role: 'user' as const,
          text: user.data.content.map((content) => content.text).join('\n').slice(0, 64 * 1024),
          observedAt: new Date(turn.startedAt === null ? 0 : turn.startedAt * 1000).toISOString() });
        const agent = agentMessageSchema.safeParse(item);
        if (agent.success && agent.data.text) items.push({ sourceItemId: agent.data.id, nativeExecutionRef: this.state.reference('turn', turn.id),
          hubAttemptId: association.attemptId, kind: 'message' as const, role: 'agent' as const, text: agent.data.text.slice(0, 64 * 1024),
          partial: agent.data.text.length > 64 * 1024, observedAt: new Date((turn.completedAt ?? turn.startedAt ?? 0) * 1000).toISOString() });
      }
    }
    const offset = input.after === undefined ? 0 : items.findIndex((item) => item.sourceItemId === input.after) + 1;
    const page = items.slice(offset, offset + Math.max(1, Math.min(input.limit, 100)));
    const cursor = page.at(-1)?.sourceItemId;
    return { items: page, ...(cursor === undefined ? {} : { nextCursor: cursor }), coverage: 'partial',
      gaps: [{ reason: LIMITATIONS[1] }, ...(input.after !== undefined && offset === 0 ? [{ reason: 'Saved cursor is outside available Hub-owned output.' }] : [])] };
  }
  async *events(ctx: CallContext, target: RuntimeTarget): AsyncIterable<RuntimeEvent> {
    const { binding, thread } = await this.thread(ctx, target);
    const attempt = binding.attempt;
    if (!attempt) return;
    const turn = thread.turns.find((candidate) => candidate.id === attempt.turnId);
    if (!turn || turn.status !== 'completed') return;
    const summary = turn.items.flatMap((item) => {
      const parsed = agentMessageSchema.safeParse(item);
      return parsed.success ? [parsed.data.text] : [];
    }).join('\n').slice(0, 64 * 1024);
    if (!summary) return;
    yield { sourceEventId: `result:${turn.id}:${digest(summary)}`, streamScope: target.hubSessionId,
      nativeSession: target.nativeSession, bindingGeneration: target.bindingGeneration, observedAt: new Date().toISOString(),
      payload: { type: 'result.submitted', attemptId: attempt.id, summary, referenceIds: [] } };
  }
}
