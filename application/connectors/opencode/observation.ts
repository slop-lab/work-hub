import type { CallContext, ExecutionObservation, OutputPage, RuntimeEvent, RuntimeSessionObservation, RuntimeTarget } from '../../contracts/index.ts';
import { digest } from '../../persistence/codec.ts';
import type { OpenCodeClient } from './client.ts';
import { OpenCodeActivity } from './activity.ts';
import type { OpenCodeState } from './state.ts';
import type { Binding, NativeMessage, NativeQuestion } from './schema.ts';

function affiliatedQuestions(binding: Binding, messages: readonly NativeMessage[], questions: readonly NativeQuestion[]) {
  return questions.filter((question) => {
    const message = messages.find((item) => item.info.id === question.tool?.messageID);
    return message?.info.role === 'assistant' && message.info.parentID !== undefined &&
      binding.attempt?.messageIds.includes(message.info.parentID);
  });
}

export class OpenCodeObservation {
  readonly client: OpenCodeClient;
  readonly state: OpenCodeState;
  private readonly activity: OpenCodeActivity;
  constructor(client: OpenCodeClient, state: OpenCodeState) {
    this.client = client; this.state = state; this.activity = new OpenCodeActivity(client);
  }

  private async inspectActivity(ctx: CallContext, target: RuntimeTarget, binding: Binding, messages: readonly NativeMessage[]) {
    const activity = await this.activity.observe(ctx, binding, messages);
    if (binding.attempt && JSON.stringify(binding.attempt.activitySessions) !== JSON.stringify(activity.sessions)) {
      this.state.save(ctx, target.hubSessionId, { ...binding, attempt: { ...binding.attempt, activitySessions: [...activity.sessions] } });
    }
    return activity;
  }

  async inspect(ctx: CallContext, target: RuntimeTarget): Promise<RuntimeSessionObservation> {
    const binding = this.state.target(ctx, target);
    await this.client.session(ctx, binding.nativeId);
    const messages = await this.client.messages(ctx, binding.nativeId);
    const questions = affiliatedQuestions(binding, messages, await this.client.questions(ctx, binding.nativeId));
    const activity = await this.inspectActivity(ctx, target, binding, messages);
    const pending = questions.map((question) => this.state.reference('question', question.id));
    let execution: ExecutionObservation = { phase: 'unknown', pendingNativeRequestRefs: pending };
    if (binding.attempt) {
      const attempt = binding.attempt;
      const lastUserId = attempt.messageIds.at(-1);
      const assistant = messages.filter((message) => message.info.role === 'assistant' && message.info.parentID === lastUserId).at(-1);
      const associated = { hubAttemptId: attempt.id,
        nativeExecutionRef: this.state.reference('execution', attempt.messageId), pendingNativeRequestRefs: pending };
      if (questions.length) execution = { ...associated, phase: 'waiting_input' };
      else if (activity.phase !== 'idle' && assistant?.info.time.completed) execution = { ...associated, phase: activity.phase };
      else if (assistant?.info.error) execution = { ...associated, phase: 'ended', termination: 'failed' };
      else if (assistant?.info.time.completed && assistant.info.finish === 'stop') execution = {
        ...associated, phase: 'ended', termination: 'completed', endedAt: new Date(assistant.info.time.completed).toISOString(),
      };
      else if (assistant && !assistant.info.time.completed) execution = { ...associated, phase: 'running' };
      else execution = { ...associated, phase: 'unknown' };
    }
    return { nativeSession: target.nativeSession, exists: true, execution,
      controlGrantValid: !binding.detached, limitations: [
        'Native permissions and unsupported question shapes require the native view.',
        'Idle and HTTP 204 are not start or success evidence. External clients may also control this session.',
        ...activity.limitations,
      ] };
  }

  async output(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string; readonly limit: number }): Promise<OutputPage> {
    const binding = this.state.target(ctx, input.target);
    const messages = await this.client.messages(ctx, binding.nativeId);
    const items = messages.flatMap((message) => {
      if (message.info.role === 'assistant' && !message.info.time.completed) return [];
      const owned = binding.ownedInputs.find((input) => input.messageId === message.info.id ||
        (message.info.role === 'assistant' && input.messageId === message.info.parentID));
      if (!owned) return [];
      return message.parts.filter((part) => part.type === 'text' && part.text).map((part) => ({
        sourceItemId: `${message.info.id}:${part.id}`, kind: 'message' as const,
        role: message.info.role === 'assistant' ? 'agent' as const : 'user' as const,
        text: part.text?.slice(0, 64 * 1024), partial: (part.text?.length ?? 0) > 64 * 1024,
        observedAt: new Date(message.info.time.created).toISOString(),
        hubAttemptId: owned.attemptId, nativeExecutionRef: this.state.reference('execution', owned.executionId),
      }));
    });
    const offset = input.after === undefined ? 0 : items.findIndex((item) => item.sourceItemId === input.after) + 1;
    const page = items.slice(offset, offset + Math.max(1, Math.min(input.limit, 100)));
    const last = page.at(-1)?.sourceItemId;
    return { items: page, ...(last === undefined ? {} : { nextCursor: last }), coverage: 'partial',
      gaps: [{ reason: 'Latest 100 messages, Hub-owned ancestry and completed text only. Unrelated history, tool output and permissions remain in the native view.' },
        ...(input.after !== undefined && offset === 0 ? [{ reason: 'Saved cursor is outside the retained message window.' }] : [])] };
  }

  async *events(ctx: CallContext, target: RuntimeTarget): AsyncIterable<RuntimeEvent> {
    const binding = this.state.target(ctx, target);
    const attempt = binding.attempt;
    if (!attempt) return;
    const messages = await this.client.messages(ctx, binding.nativeId);
    const activity = await this.inspectActivity(ctx, target, binding, messages);
    const envelope = { nativeSession: target.nativeSession, bindingGeneration: target.bindingGeneration,
      streamScope: target.hubSessionId, observedAt: new Date().toISOString() };
    for (const question of affiliatedQuestions(binding, messages, await this.client.questions(ctx, binding.nativeId))) {
      const item = question.questions[0];
      if (question.questions.length !== 1 || !item || item.multiple) continue;
      const nativeRequestRef = this.state.reference('question', question.id);
      const revision = digest(question);
      yield { ...envelope, sourceEventId: `question:${question.id}:${revision}`, payload: {
        type: 'request.created', request: { nativeRequestRef, nativeRequestRevision: revision, responseRoute: 'native',
          draft: { kind: 'question', projectId: binding.selection.projectId, taskId: attempt.taskId,
            recipient: { kind: 'project_members', projectId: binding.selection.projectId }, prompt: item.question,
            referenceIds: [], blocking: 'runtime_action',
            answerSchema: item.custom !== false ? { kind: 'text', minLength: 1, maxLength: 16_384 } : {
              kind: 'single_choice', options: item.options.map((option, index) => ({ id: String(index), label: option.label })),
            }, validity: { kind: 'attempt', target: { ...target, hubAttemptId: attempt.id }, nativeRequestRef, nativeRequestRevision: revision },
          } },
      } };
    }
    const latest = attempt.messageIds.at(-1);
    for (const message of messages) {
      if (activity.phase !== 'idle' || message.info.role !== 'assistant' || message.info.parentID !== latest || !message.info.time.completed ||
        message.info.error || message.info.finish !== 'stop') continue;
      const summary = message.parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n').slice(0, 64 * 1024);
      if (summary) yield { ...envelope, sourceEventId: `result:${message.info.id}:${digest(summary)}`, payload: {
        type: 'result.submitted', attemptId: attempt.id, summary, referenceIds: [],
      } };
    }
  }
}
