import type { CallContext, ExecutionObservation, OutputItem, OutputPage, RuntimeEvent, RuntimeSessionObservation, RuntimeTarget } from '../../contracts/index.ts';
import { digest } from '../../persistence/codec.ts';
import { CodexProtocolError, type CodexProtocol, type CodexProtocolEvent } from './protocol.ts';
import { agentMessageSchema, errorNotificationSchema, itemCompletedNotificationSchema, itemStartedNotificationSchema,
  rateLimitsUpdatedNotificationSchema, threadReadResponseSchema, threadStatusChangedNotificationSchema,
  toolRequestUserInputParamsSchema, turnNotificationSchema, unsupportedServerRequestSchema, userMessageSchema,
  type CodexBinding, type CodexThread } from './schema.ts';
import type { CodexState } from './state.ts';

const LIMITATIONS = [
  'Only one non-secret text or fixed-choice Codex question is bridged; other questions and all approvals require an authenticated native Codex client.',
  'Only Hub-owned turns and completed user/agent messages are imported; tool activity and unrelated history remain native.',
  'Child activity coverage is unavailable; native reconciliation is required before claiming completion.',
  'A turn response proves input receipt, not successful execution or task completion.',
] as const;

function execution(state: CodexState, binding: CodexBinding, thread: CodexThread): ExecutionObservation {
  const attempt = binding.attempt;
  if (!attempt) return { phase: thread.status.type === 'idle' ? 'idle' : 'unknown', pendingNativeRequestRefs: [] };
  const turn = thread.turns.find((candidate) => candidate.id === attempt.turnId);
  const common = { hubAttemptId: attempt.id, nativeExecutionRef: state.reference('turn', attempt.turnId), pendingNativeRequestRefs: [] };
  if (!turn) return { ...common, phase: 'unknown' };
  switch (turn.status) {
    case 'inProgress': return { ...common,
      phase: thread.status.type === 'active' && thread.status.activeFlags.length > 0 ? 'waiting_input' : 'running',
      ...(turn.startedAt === null ? {} : { startedAt: new Date(turn.startedAt * 1000).toISOString() }) };
    case 'completed': return { ...common, phase: 'ended', termination: 'completed', ...(turn.completedAt === null ? {} : { endedAt: new Date(turn.completedAt * 1000).toISOString() }) };
    case 'interrupted': return { ...common, phase: 'ended', termination: 'stopped', ...(turn.completedAt === null ? {} : { endedAt: new Date(turn.completedAt * 1000).toISOString() }) };
    case 'failed': return { ...common, phase: 'ended', termination: 'failed', ...(turn.completedAt === null ? {} : { endedAt: new Date(turn.completedAt * 1000).toISOString() }) };
  }
}

function nativeQuestion(state: CodexState, binding: CodexBinding, target: RuntimeTarget,
  event: CodexProtocolEvent): RuntimeEvent | undefined {
  if (event.method !== 'item/tool/requestUserInput' || event.nativeRequestId === undefined || !binding.attempt) return undefined;
  const parsed = toolRequestUserInputParamsSchema.safeParse(event.params);
  const question = parsed.success ? parsed.data.questions[0] : undefined;
  if (!parsed.success || parsed.data.questions.length !== 1 || !question || question.isSecret ||
    (question.options !== null && (question.isOther || question.options.length === 0)) ||
    parsed.data.threadId !== binding.nativeId || parsed.data.turnId !== binding.attempt.turnId) return undefined;
  const nativeRequestRef = state.reference('question', event.nativeRequestId);
  const revision = digest(parsed.data);
  return { sourceEventId: `question:${event.nativeRequestId}:${revision}`, streamScope: target.hubSessionId,
    nativeSession: target.nativeSession, bindingGeneration: target.bindingGeneration, observedAt: new Date().toISOString(),
    payload: { type: 'request.created', request: { nativeRequestRef, nativeRequestRevision: revision, responseRoute: 'native',
      draft: { kind: 'question', projectId: binding.selection.projectId, taskId: binding.attempt.taskId,
        recipient: { kind: 'project_members', projectId: binding.selection.projectId }, prompt: question.question,
        ...(question.header ? { reason: question.header } : {}), referenceIds: [],
        blocking: parsed.data.isBlocking ? 'runtime_action' : 'none', answerSchema: question.options === null
          ? { kind: 'text', minLength: 1, maxLength: 16_384 }
          : { kind: 'single_choice', options: question.options.map((option, index) => ({ id: String(index), label: option.label })) },
        validity: { kind: 'attempt', target: { ...target, hubAttemptId: binding.attempt.id }, nativeRequestRef,
          nativeRequestRevision: revision },
      },
    } } };
}

function lifecycleExtension(target: RuntimeTarget, event: CodexProtocolEvent): RuntimeEvent | undefined {
  const common = { streamScope: target.hubSessionId, nativeSession: target.nativeSession,
    bindingGeneration: target.bindingGeneration, sourceEventId: `codex:${digest(event)}` };
  switch (event.method) {
    case 'turn/started':
    case 'turn/completed': {
      const parsed = turnNotificationSchema.safeParse(event.params);
      if (!parsed.success || parsed.data.threadId !== target.nativeSession.id) return undefined;
      const observedAt = new Date(((event.method === 'turn/started' ? parsed.data.turn.startedAt : parsed.data.turn.completedAt) ?? 0) * 1000).toISOString();
      return { ...common, observedAt, payload: { type: 'extension', namespace: 'workhub.codex.lifecycle.v1', data: {
        kind: event.method === 'turn/started' ? 'turn_started' : 'turn_completed', threadId: parsed.data.threadId,
        turnId: parsed.data.turn.id, status: parsed.data.turn.status,
      } } };
    }
    case 'item/started':
    case 'item/completed': {
      const parsed = event.method === 'item/started'
        ? itemStartedNotificationSchema.safeParse(event.params)
        : itemCompletedNotificationSchema.safeParse(event.params);
      if (!parsed.success || parsed.data.threadId !== target.nativeSession.id) return undefined;
      const observedAtMs = 'startedAtMs' in parsed.data ? parsed.data.startedAtMs : parsed.data.completedAtMs;
      return { ...common, observedAt: new Date(observedAtMs).toISOString(), payload: {
        type: 'extension', namespace: 'workhub.codex.lifecycle.v1', data: {
          kind: event.method === 'item/started' ? 'item_started' : 'item_completed', itemId: parsed.data.item.id,
          itemType: parsed.data.item.type, threadId: parsed.data.threadId, turnId: parsed.data.turnId, observedAtMs,
        },
      } };
    }
    case 'error': {
      const parsed = errorNotificationSchema.safeParse(event.params);
      if (!parsed.success || parsed.data.threadId !== target.nativeSession.id) return undefined;
      return { ...common, observedAt: new Date().toISOString(), payload: {
        type: 'extension', namespace: 'workhub.codex.lifecycle.v1', data: {
          kind: parsed.data.willRetry ? 'retry_observed' : 'provider_error_observed',
          errorKind: typeof parsed.data.error.codexErrorInfo === 'string' ? parsed.data.error.codexErrorInfo : 'other',
          willRetry: parsed.data.willRetry, retryOrdinal: null, retryLimit: null,
          threadId: parsed.data.threadId, turnId: parsed.data.turnId,
        },
      } };
    }
    case 'account/rateLimits/updated': {
      const parsed = rateLimitsUpdatedNotificationSchema.safeParse(event.params);
      if (!parsed.success) return undefined;
      return { ...common, observedAt: new Date().toISOString(), payload: {
        type: 'extension', namespace: 'workhub.codex.lifecycle.v1', data: {
          kind: 'rate_limit_observed', scope: 'account',
          ...(parsed.data.rateLimits.limitId === null ? {} : { limitId: parsed.data.rateLimits.limitId }),
          ...(parsed.data.rateLimits.primary === null ? {} : {
            usedPercent: parsed.data.rateLimits.primary.usedPercent,
            ...(parsed.data.rateLimits.primary.resetsAt === null ? {} : { resetsAt: parsed.data.rateLimits.primary.resetsAt }),
          }),
        },
      } };
    }
    case 'thread/status/changed': {
      const parsed = threadStatusChangedNotificationSchema.safeParse(event.params);
      if (!parsed.success || parsed.data.threadId !== target.nativeSession.id) return undefined;
      return { ...common, observedAt: new Date().toISOString(), payload: {
        type: 'extension', namespace: 'workhub.codex.lifecycle.v1', data: {
          kind: 'thread_status_changed', threadId: parsed.data.threadId, status: parsed.data.status.type,
          ...(parsed.data.status.type === 'active' ? { activeFlags: parsed.data.status.activeFlags } : {}),
        },
      } };
    }
    default: return undefined;
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
  private pending(binding: CodexBinding) {
    return this.protocol.pendingServerRequests().flatMap((event) => {
      if (event.method !== 'item/tool/requestUserInput' || event.nativeRequestId === undefined) return [];
      const parsed = toolRequestUserInputParamsSchema.safeParse(event.params);
      return parsed.success && parsed.data.threadId === binding.nativeId && parsed.data.turnId === binding.attempt?.turnId
        ? [this.state.reference('question', event.nativeRequestId)] : [];
    });
  }
  async inspect(ctx: CallContext, target: RuntimeTarget): Promise<RuntimeSessionObservation> {
    const binding = this.state.target(ctx, target);
    const pendingNativeRequestRefs = this.pending(binding);
    let thread: CodexThread;
    try { thread = (await this.thread(ctx, target)).thread; }
    catch (error) {
      if (!(error instanceof CodexProtocolError) || error.code !== -32601) throw error;
      const phase = pendingNativeRequestRefs.length > 0 ? 'waiting_input' as const : 'unknown' as const;
      return { nativeSession: target.nativeSession, exists: true,
        execution: { ...(binding.attempt === undefined ? {} : { hubAttemptId: binding.attempt.id }), phase,
          pendingNativeRequestRefs }, controlGrantValid: !binding.detached, limitations: [...LIMITATIONS,
          'Codex thread state is temporarily unavailable while the active turn owns app-server input.'],
        activity: { coverage: 'unknown', truncated: false,
          nodes: [{ nativeSession: target.nativeSession, relation: 'root', phase }] } };
    }
    const currentExecution = execution(this.state, binding, thread);
    const observedExecution = pendingNativeRequestRefs.length === 0 ? currentExecution : {
      ...currentExecution, phase: 'waiting_input' as const, pendingNativeRequestRefs,
    };
    const activityPhase = observedExecution.phase === 'running' || observedExecution.phase === 'waiting_input' || observedExecution.phase === 'idle'
      ? observedExecution.phase : 'unknown';
    return { nativeSession: target.nativeSession, exists: true, execution: observedExecution,
      controlGrantValid: !binding.detached, limitations: [...LIMITATIONS], activity: { coverage: 'unknown', truncated: false,
        nodes: [{ nativeSession: target.nativeSession, relation: 'root', phase: activityPhase }] } };
  }
  async output(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string; readonly limit: number }): Promise<OutputPage> {
    let value: { readonly binding: CodexBinding; readonly thread: CodexThread };
    try { value = await this.thread(ctx, input.target); }
    catch (error) {
      if (!(error instanceof CodexProtocolError) || error.code !== -32601) throw error;
      return { items: [], coverage: 'partial', gaps: [{ reason:
        'Codex output is temporarily unavailable while the active turn owns app-server input.' }] };
    }
    const { binding, thread } = value;
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
    const binding = this.state.target(ctx, target);
    const attempt = binding.attempt;
    if (!attempt) return;
    let pendingQuestion = false;
    for (const event of this.protocol.drainEvents()) {
      const question = nativeQuestion(this.state, binding, target, event);
      if (question !== undefined) { pendingQuestion = true; yield question; continue; }
      if (event.method === 'workhub/serverRequestUnsupported') {
        const unsupported = unsupportedServerRequestSchema.safeParse(event.params);
        if (unsupported.success && (unsupported.data.threadId === undefined || unsupported.data.threadId === binding.nativeId)) {
          yield { sourceEventId: `unsupported:${digest(unsupported.data)}`, streamScope: target.hubSessionId,
            nativeSession: target.nativeSession, bindingGeneration: target.bindingGeneration, observedAt: new Date().toISOString(),
            payload: { type: 'gap', reason: 'This Codex interaction requires an authenticated native Codex client.' } };
        }
        continue;
      }
      const mapped = lifecycleExtension(target, event);
      if (mapped !== undefined) yield mapped;
    }
    if (pendingQuestion) return;
    let thread: CodexThread;
    try { thread = (await this.thread(ctx, target)).thread; }
    catch (error) {
      if (!(error instanceof CodexProtocolError) || error.code !== -32601) throw error;
      yield { sourceEventId: `gap:thread-read:${attempt.turnId}`, streamScope: target.hubSessionId,
        nativeSession: target.nativeSession, bindingGeneration: target.bindingGeneration,
        observedAt: new Date().toISOString(), payload: { type: 'gap',
          reason: 'Codex thread state is temporarily unavailable while the active turn owns app-server input.' } };
      return;
    }
    const turn = thread.turns.find((candidate) => candidate.id === attempt.turnId);
    if (turn?.status !== 'completed') return;
    const summary = turn.items.flatMap((item) => {
      const parsed = agentMessageSchema.safeParse(item);
      return parsed.success && parsed.data.phase === 'final_answer' ? [parsed.data.text] : [];
    }).join('\n').slice(0, 64 * 1024);
    if (summary) yield { sourceEventId: `result:${turn.id}:${digest(summary)}`, streamScope: target.hubSessionId,
      nativeSession: target.nativeSession, bindingGeneration: target.bindingGeneration, observedAt: new Date().toISOString(),
      payload: { type: 'result.submitted', attemptId: attempt.id, summary, referenceIds: [] } };
  }
}
