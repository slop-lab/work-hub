import { z } from 'zod';
import type { ClaudeMessage } from './schema.ts';

const MAX_ACTIVITY_TASKS = 31;
const rawContentSchema = z.object({ type: z.string(), text: z.string().optional(), id: z.string().optional(),
  name: z.string().optional() }).passthrough();
const rawTaskSchema = z.object({ task_id: z.string(), run_id: z.string().optional(), task_type: z.string(),
  subagent_type: z.string().optional(), description: z.string(), parent_task_id: z.string().optional(),
  ambient: z.boolean().optional() }).passthrough();
const rawMessageSchema = z.object({
  type: z.string(), subtype: z.string().optional(), session_id: z.string().optional(), uuid: z.string().optional(),
  timestamp: z.string().optional(), user_message_uuid: z.string().optional(), user_message_uuids: z.array(z.string()).optional(),
  parent_tool_use_id: z.string().nullable().optional(), result: z.string().optional(), is_error: z.boolean().optional(),
  terminal_reason: z.string().optional(), startup_failure_reason: z.string().optional(), queued_turn_count: z.number().int().optional(),
  errors: z.array(z.string()).optional(), message: z.object({ content: z.array(rawContentSchema) }).passthrough().optional(),
  attempt: z.number().int().optional(), max_retries: z.number().int().optional(), retry_delay_ms: z.number().optional(),
  error_status: z.number().nullable().optional(), error: z.string().optional(),
  no_response: z.object({ waited_ms: z.number(), retry_wait_ms: z.number() }).optional(),
  rate_limit_info: z.object({ status: z.enum(['allowed', 'allowed_warning', 'rejected']), resetsAt: z.number().optional(),
    rateLimitType: z.enum(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet',
      'seven_day_overage_included', 'overage']).optional(), utilization: z.number().optional(),
    overageStatus: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(), overageResetsAt: z.number().optional(),
    overageDisabledReason: z.string().optional(), isUsingOverage: z.boolean().optional(), overageInUse: z.boolean().optional(),
    overageEnabled: z.boolean().optional(), surpassedThreshold: z.number().optional(),
    limitScope: z.enum(['service', 'channel', 'group_pool']).optional(), errorCode: z.literal('credits_required').optional(),
    canUserPurchaseCredits: z.boolean().optional(), hasChargeableSavedPaymentMethod: z.boolean().optional() }).optional(),
  tool_use_id: z.string().optional(), tool_name: z.string().optional(), elapsed_time_seconds: z.number().optional(),
  task_id: z.string().optional(), run_id: z.string().optional(), subagent_type: z.string().optional(),
  subagent_retry: z.object({ agent_id: z.string(), attempt: z.number().int(), max_retries: z.number().int(),
    retry_delay_ms: z.number(), error_status: z.number().nullable(), error_category: z.string() }).optional(),
  description: z.string().optional(), parent_task_id: z.string().optional(), ambient: z.boolean().optional(),
  heartbeat: z.boolean().optional(), task_type: z.string().optional(), is_backgrounded: z.boolean().optional(),
  spawn_depth: z.number().int().optional(), workflow_name: z.string().optional(), skip_transcript: z.boolean().optional(),
  last_tool_name: z.string().optional(), output_file: z.string().optional(),
  usage: z.object({ total_tokens: z.number(), tool_uses: z.number().int(), duration_ms: z.number() }).optional(),
  status: z.string().nullable().optional(), summary: z.string().optional(), patch: z.object({ status: z.string().optional(),
    description: z.string().optional(), error: z.string().optional(), is_backgrounded: z.boolean().optional() }).passthrough().optional(),
  tasks: z.array(rawTaskSchema).optional(),
  model: z.string().optional(), cwd: z.string().optional(), tools: z.array(z.string()).optional(),
  permissionMode: z.string().optional(), capabilities: z.array(z.string()).optional(), claude_code_version: z.string().optional(),
  reason: z.string().optional(),
  state: z.string().optional(),
}).passthrough();

export type ClaudeTurnFrame = { readonly affiliated: boolean; readonly acknowledged: boolean;
  readonly cleared: boolean; readonly sessionId?: string; readonly message?: ClaudeMessage; readonly messages?: readonly ClaudeMessage[] };

function subagentPhase(status: string | undefined): Extract<ClaudeMessage, { kind: 'subagent' }>['phase'] {
  switch (status) {
    case 'pending': case 'running': case 'paused': return 'running';
    case 'completed': return 'completed';
    case 'failed': case 'killed': return 'failed';
    case 'stopped': return 'stopped';
    default: return 'unknown';
  }
}

function resultOutcome(parsed: z.infer<typeof rawMessageSchema>): Extract<ClaudeMessage, { kind: 'result' }>['outcome'] {
  if (parsed.subtype !== 'success' || parsed.is_error === true) return 'failed';
  switch (parsed.terminal_reason) {
    case undefined: case 'completed': return 'completed';
    case 'aborted_streaming': case 'aborted_tools': case 'hook_stopped': return 'interrupted';
    default: return 'failed';
  }
}

function lifecycleMessages(parsed: z.infer<typeof rawMessageSchema>, observedAt: string): readonly ClaudeMessage[] {
  const id = parsed.uuid ?? `${parsed.type}:${parsed.subtype ?? 'event'}:${observedAt}`;
  if (parsed.type === 'system' && parsed.subtype === 'api_retry' && parsed.attempt !== undefined &&
    parsed.max_retries !== undefined && parsed.retry_delay_ms !== undefined && parsed.error_status !== undefined && parsed.error) return [{
      kind: 'retry', id, attempt: parsed.attempt, maxRetries: parsed.max_retries, retryDelayMs: parsed.retry_delay_ms,
      errorStatus: parsed.error_status, error: parsed.error, ...(parsed.no_response === undefined ? {} : { noResponse: {
        waitedMs: parsed.no_response.waited_ms, retryWaitMs: parsed.no_response.retry_wait_ms } }), observedAt,
    }];
  if (parsed.type === 'rate_limit_event' && parsed.rate_limit_info) return [{ kind: 'rate_limit', id,
    ...parsed.rate_limit_info, observedAt }];
  if (parsed.type === 'tool_progress' && parsed.tool_use_id && parsed.tool_name &&
    parsed.parent_tool_use_id !== undefined && parsed.elapsed_time_seconds !== undefined) return [{ kind: 'tool', id,
      toolUseId: parsed.tool_use_id, toolName: parsed.tool_name, parentToolUseId: parsed.parent_tool_use_id,
      elapsedSeconds: parsed.elapsed_time_seconds, ...(parsed.task_id === undefined ? {} : { taskId: parsed.task_id }),
      ...(parsed.heartbeat === undefined ? {} : { heartbeat: parsed.heartbeat }),
      ...(parsed.subagent_type === undefined ? {} : { subagentType: parsed.subagent_type }),
      ...(parsed.subagent_retry === undefined ? {} : { retry: { agentId: parsed.subagent_retry.agent_id,
        attempt: parsed.subagent_retry.attempt, maxRetries: parsed.subagent_retry.max_retries,
        retryDelayMs: parsed.subagent_retry.retry_delay_ms, errorStatus: parsed.subagent_retry.error_status,
        errorCategory: parsed.subagent_retry.error_category } }), observedAt }];
  if (parsed.type === 'system' && parsed.subtype === 'background_tasks_changed' && parsed.tasks) return [{
    kind: 'subagent_registry', id, tasks: parsed.tasks.slice(0, MAX_ACTIVITY_TASKS).map((task) => ({ taskId: task.task_id,
      ...(task.run_id === undefined ? {} : { runId: task.run_id }), taskType: task.task_type,
      ...(task.subagent_type === undefined ? {} : { subagentType: task.subagent_type }), description: task.description,
      ...(task.parent_task_id === undefined ? {} : { parentTaskId: task.parent_task_id }), ambient: task.ambient === true })),
    truncated: parsed.tasks.length > MAX_ACTIVITY_TASKS, observedAt }];
  if (parsed.type === 'system' && parsed.task_id && ['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(parsed.subtype ?? '')) {
    const terminalStatus = parsed.subtype === 'task_notification' ? parsed.status ?? undefined : parsed.patch?.status;
    const event = parsed.subtype === 'task_started' ? 'started' : parsed.subtype === 'task_progress' ? 'progress' :
      parsed.subtype === 'task_notification' && terminalStatus === 'completed' ? 'completed' :
        parsed.subtype === 'task_notification' && terminalStatus === 'failed' ? 'failed' :
          parsed.subtype === 'task_notification' && terminalStatus === 'stopped' ? 'stopped' : 'updated';
    const phase = parsed.subtype === 'task_started' || parsed.subtype === 'task_progress' ? 'running' : subagentPhase(terminalStatus);
    const isBackgrounded = parsed.is_backgrounded ?? parsed.patch?.is_backgrounded;
    return [{ kind: 'subagent', id, event, taskId: parsed.task_id, ...(parsed.run_id === undefined ? {} : { runId: parsed.run_id }),
      ...(parsed.tool_use_id === undefined ? {} : { toolUseId: parsed.tool_use_id }),
      ...((parsed.description ?? parsed.patch?.description) === undefined ? {} : { description: parsed.description ?? parsed.patch?.description }),
      ...(parsed.subagent_type === undefined ? {} : { subagentType: parsed.subagent_type }),
      ...(parsed.parent_task_id === undefined ? {} : { parentTaskId: parsed.parent_task_id }), phase,
      ambient: parsed.ambient === true, ...(parsed.task_type === undefined ? {} : { taskType: parsed.task_type }),
      ...(isBackgrounded === undefined ? {} : { isBackgrounded }),
      ...(parsed.spawn_depth === undefined ? {} : { spawnDepth: parsed.spawn_depth }),
      ...(parsed.workflow_name === undefined ? {} : { workflowName: parsed.workflow_name }),
      ...(parsed.skip_transcript === undefined ? {} : { skipTranscript: parsed.skip_transcript }),
      ...(parsed.last_tool_name === undefined ? {} : { lastToolName: parsed.last_tool_name }),
      ...(parsed.output_file === undefined ? {} : { outputFile: parsed.output_file }),
      ...(parsed.patch?.error === undefined ? {} : { error: parsed.patch.error }),
      ...(parsed.usage === undefined ? {} : { usage: { totalTokens: parsed.usage.total_tokens,
        toolUses: parsed.usage.tool_uses, durationMs: parsed.usage.duration_ms } }),
      ...(parsed.summary === undefined ? {} : { summary: parsed.summary }), observedAt }];
  }
  if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.model && parsed.cwd && parsed.tools && parsed.permissionMode) return [{
    kind: 'startup', id, ...(parsed.claude_code_version === undefined ? {} : { version: parsed.claude_code_version }),
    model: parsed.model, cwd: parsed.cwd, tools: parsed.tools.slice(0, 256),
    permissionMode: parsed.permissionMode, capabilities: (parsed.capabilities ?? []).slice(0, 256), observedAt }];
  if (parsed.type === 'system' && parsed.subtype === 'session_state_changed' &&
    (parsed.state === 'idle' || parsed.state === 'running' || parsed.state === 'requires_action')) return [{
      kind: 'state', id, state: parsed.state, observedAt }];
  if (parsed.type === 'system' && parsed.subtype === 'status' && (parsed.status === 'compacting' || parsed.status === 'requesting')) return [{
    kind: 'state', id, state: parsed.status, observedAt }];
  if (parsed.type === 'system' && parsed.subtype === 'worker_shutting_down') return [{ kind: 'state', id,
    state: 'shutting_down', ...(parsed.reason === undefined ? {} : { reason: parsed.reason }), observedAt }];
  return [];
}

export function isClaudeLifecycleFrame(value: unknown): boolean {
  const parsed = rawMessageSchema.safeParse(value);
  return parsed.success && parsed.data.type !== 'assistant' && parsed.data.type !== 'result' && parsed.data.type !== 'user';
}

export function parseClaudeTurnFrame(value: unknown, inputId: string, affiliated: boolean): ClaudeTurnFrame {
  const parsed = rawMessageSchema.parse(value);
  const echoesInput = parsed.user_message_uuid === inputId || parsed.user_message_uuids?.includes(inputId) === true;
  const identifiesInput = parsed.user_message_uuid !== undefined || parsed.user_message_uuids !== undefined;
  const retainedAffiliation = identifiesInput && !echoesInput ? false : affiliated;
  const observedAt = parsed.timestamp ?? new Date().toISOString();
  if (parsed.type === 'assistant') {
    const mainThread = parsed.parent_tool_use_id === null;
    const nextAffiliated = retainedAffiliation || (mainThread && echoesInput);
    const text = parsed.message?.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n') ?? '';
    const messages: ClaudeMessage[] = mainThread && nextAffiliated && text ? [{ kind: 'assistant', frame: 'checkpoint',
      id: parsed.uuid ?? 'assistant:unknown', text: text.slice(0, 64 * 1024), ...(text.length > 64 * 1024 ? { partial: true } : {}),
      observedAt }] : [];
    if (mainThread && nextAffiliated) for (const part of parsed.message?.content ?? []) {
      if (part.type === 'tool_use' && part.id && part.name) messages.push({ kind: 'tool',
        id: `${parsed.uuid ?? 'assistant:unknown'}:${part.id}`, toolUseId: part.id, toolName: part.name,
        parentToolUseId: null, elapsedSeconds: 0, observedAt });
    }
    return { affiliated: nextAffiliated, acknowledged: mainThread && echoesInput, cleared: identifiesInput && !echoesInput,
      ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
      ...(messages[0] === undefined ? {} : { message: messages[0], messages }) };
  }
  if (parsed.type === 'result') {
    const linked = retainedAffiliation || echoesInput;
    const summary = parsed.result ?? parsed.errors?.join('\n') ?? '';
    const message: ClaudeMessage = { kind: 'result', frame: 'final', id: parsed.uuid ?? 'result:unknown',
      outcome: resultOutcome(parsed), summary: summary.slice(0, 64 * 1024), ...(summary.length > 64 * 1024 ? { partial: true } : {}),
      ...(parsed.terminal_reason === undefined ? {} : { terminalReason: parsed.terminal_reason }),
      ...(parsed.startup_failure_reason === undefined ? {} : { startupFailureReason: parsed.startup_failure_reason }),
      ...(parsed.queued_turn_count === undefined ? {} : { queuedTurnCount: parsed.queued_turn_count }), observedAt };
    return { affiliated: false, acknowledged: echoesInput, cleared: identifiesInput && !echoesInput,
      ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
      ...(linked ? { message, messages: [message] } : {}) };
  }
  const messages = retainedAffiliation ? lifecycleMessages(parsed, observedAt) : [];
  return { affiliated: retainedAffiliation, acknowledged: false, cleared: identifiesInput && !echoesInput,
    ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
    ...(messages[0] === undefined ? {} : { message: messages[0], messages }) };
}
