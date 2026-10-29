import type { CallContext, RuntimeActivityObservation, RuntimeEvent, RuntimeSessionObservation, RuntimeTarget } from '../../contracts/index.ts';
import { JsonObjectSchema } from '../../contracts/index.ts';
import type { ClaudeBoundMessage, ClaudeMessage } from './schema.ts';
import type { ClaudeState } from './state.ts';

export class ClaudeObservation {
  private readonly state: ClaudeState;
  constructor(state: ClaudeState) { this.state = state; }

  inspect(ctx: CallContext, target: RuntimeTarget): RuntimeSessionObservation {
    const binding = this.state.target(ctx, target);
    const results = binding.messages.filter((entry): entry is ClaudeBoundMessage & {
      readonly message: Extract<ClaudeMessage, { kind: 'result' }>
    } => entry.attemptId === binding.attempt?.id && entry.message.kind === 'result');
    const result = binding.attempt === undefined ? undefined : results.at(-1)?.message;
    const activity = this.activity(binding, target, binding.attempt?.id);
    const activeDescendant = activity.nodes.some((node) => node.relation === 'descendant' && node.phase === 'running');
    const finalObservable = activity.coverage === 'complete' && !activity.truncated && !activeDescendant;
    const waiting = binding.messages.some((entry) => entry.attemptId === binding.attempt?.id &&
      entry.message.kind === 'state' && entry.message.state === 'requires_action');
    const execution = binding.attempt === undefined ? { phase: 'unknown' as const, pendingNativeRequestRefs: [] } : result === undefined ?
      { hubAttemptId: binding.attempt.id, phase: waiting ? 'waiting_input' as const : activeDescendant ? 'running' as const : 'unknown' as const,
        pendingNativeRequestRefs: [] } : !finalObservable ? {
          hubAttemptId: binding.attempt.id, phase: activeDescendant ? 'running' as const : 'unknown' as const,
          pendingNativeRequestRefs: [],
        } : {
          hubAttemptId: binding.attempt.id, phase: 'ended' as const,
          termination: result.outcome === 'completed' ? 'completed' as const : result.outcome === 'interrupted' ? 'stopped' as const : 'failed' as const,
          endedAt: result.observedAt, pendingNativeRequestRefs: [],
        };
    return { nativeSession: target.nativeSession, exists: true, execution, controlGrantValid: !binding.detached, activity,
      limitations: ['Only Hub-initiated main-thread Agent SDK turns are replayed. Native questions and approvals require Claude Code.',
        'Input confirmation waits for exact Agent SDK user-message UUID ancestry; unknown delivery is never resent.'] };
  }

  private activity(binding: ReturnType<ClaudeState['target']>, target: RuntimeTarget,
    attemptId: string | undefined): RuntimeActivityObservation {
    const attemptMessages = binding.messages.filter((entry) => entry.attemptId === attemptId).map((entry) => entry.message);
    const result = attemptMessages.some((message) => message.kind === 'result');
    const latestRegistry = attemptMessages.filter((message): message is Extract<ClaudeMessage, { kind: 'subagent_registry' }> =>
      message.kind === 'subagent_registry').at(-1);
    const subagents = attemptMessages.filter((message): message is Extract<ClaudeMessage, { kind: 'subagent' }> =>
      message.kind === 'subagent' && !message.ambient);
    const toolSubagents = attemptMessages.some((message) => message.kind === 'tool' && message.subagentType !== undefined);
    const coverageTruncated = attemptMessages.some((message) => message.kind === 'coverage');
    const uncollectedContinuation = attemptMessages.some((message) => message.kind === 'result' &&
      (message.terminalReason === 'background_requested' || (message.queuedTurnCount ?? 0) > 0));
    const rootPhase = result ? 'idle' as const : subagents.some((message) => message.phase === 'running') ? 'running' as const : 'unknown' as const;
    const root = { nativeSession: target.nativeSession, relation: 'root' as const, phase: rootPhase };
    if (latestRegistry) return { coverage: latestRegistry.truncated ? 'partial' : 'complete', truncated: latestRegistry.truncated,
      nodes: [root, ...latestRegistry.tasks.filter((task) => !task.ambient).map((task) => ({
        nativeSession: this.state.reference('agent-task', task.taskId), parentNativeSession: target.nativeSession,
        relation: 'descendant' as const, phase: 'running' as const,
      }))] };
    if (subagents.length > 0 || toolSubagents || coverageTruncated || uncollectedContinuation) return {
      coverage: 'partial', truncated: coverageTruncated, nodes: [root,
      ...subagents.slice(-31).map((task) => ({ nativeSession: this.state.reference('agent-task', task.taskId),
        parentNativeSession: target.nativeSession, relation: 'descendant' as const,
        phase: task.phase === 'running' ? 'running' as const : task.phase === 'unknown' ? 'unknown' as const : 'idle' as const }))] };
    return { coverage: 'complete', truncated: false, nodes: [root] };
  }

  output(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string; readonly limit: number }) {
    const binding = this.state.target(ctx, input.target);
    const visible = binding.messages.filter((entry) => entry.message.kind === 'assistant');
    const cursorIndex = input.after === undefined ? undefined : visible.findIndex((entry) => entry.message.id === input.after);
    const offset = cursorIndex === undefined || cursorIndex < 0 ? 0 : cursorIndex + 1;
    const page = visible.slice(offset, offset + Math.max(1, Math.min(input.limit, 100)));
    return { items: page.map((entry) => ({ sourceItemId: entry.message.id, kind: 'message' as const, role: 'agent' as const,
      text: entry.message.kind === 'assistant' ? entry.message.text : '', observedAt: entry.message.observedAt,
      ...(entry.message.kind === 'assistant' && entry.message.partial === true ? { partial: true } : {}),
      extensions: { frame: 'checkpoint', provider: 'claude-code' }, hubAttemptId: entry.attemptId,
      nativeExecutionRef: this.state.reference('execution', entry.inputId) })),
      ...(page.at(-1) === undefined ? {} : { nextCursor: page.at(-1)?.message.id ?? '' }), coverage: 'partial' as const,
      gaps: [{ reason: 'Only output from Hub-initiated Agent SDK turns is retained.' },
        ...(input.after !== undefined && cursorIndex === -1 ? [{ reason: 'Saved cursor is outside the retained Claude output window.' }] : [])] };
  }

  async *events(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string }): AsyncIterable<RuntimeEvent> {
    const binding = this.state.target(ctx, input.target);
    let afterSeen = input.after === undefined;
    for (const entry of binding.messages) {
      const sourceEventId = `${entry.message.kind}:${entry.message.id}`;
      if (!afterSeen) {
        afterSeen = sourceEventId === input.after || entry.message.id === input.after;
        continue;
      }
      const envelope = { sourceEventId, streamScope: input.target.hubSessionId,
        nativeSession: input.target.nativeSession, bindingGeneration: input.target.bindingGeneration,
        observedAt: entry.message.observedAt };
      if (entry.message.kind === 'result') {
        const activity = this.activity(binding, input.target, entry.attemptId);
        const finalObservable = activity.coverage === 'complete' && !activity.truncated &&
          !activity.nodes.some((node) => node.relation === 'descendant' && node.phase === 'running');
        if (finalObservable) yield { ...envelope, payload: { type: 'result.submitted', attemptId: entry.attemptId,
          summary: entry.message.summary, referenceIds: [] } };
        continue;
      }
      if (entry.message.kind !== 'assistant') yield { ...envelope, payload: { type: 'extension',
        namespace: 'workhub.claude.lifecycle.v1', data: JsonObjectSchema.parse(entry.message) } };
    }
    if (!afterSeen && input.after !== undefined) yield { sourceEventId: `gap:${input.after}`, streamScope: input.target.hubSessionId,
      nativeSession: input.target.nativeSession, bindingGeneration: input.target.bindingGeneration, observedAt: new Date().toISOString(),
      payload: { type: 'gap', reason: 'Saved cursor is outside the retained Claude lifecycle window.' } };
  }
}
