import type { CallContext } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import type { OpenCodeClient } from './client.ts';
import type { Binding, NativeMessage, NativeSession } from './schema.ts';

const MAX_ACTIVITY_SESSIONS = 32;
const MAX_ACTIVITY_DEPTH = 4;
const ACTIVITY_DEADLINE_MS = 8_000;
const SESSION_ID = /\bses_[A-Za-z0-9]+\b/g;

export type ActivitySession = { readonly id: string; readonly parentId: string; readonly rootMessageId: string };
export type ActivityObservation = {
  readonly phase: 'idle' | 'running' | 'unknown';
  readonly sessions: readonly ActivitySession[];
  readonly limitations: readonly string[];
};

function linkedChildren(messages: readonly NativeMessage[], roots?: ReadonlySet<string>): Map<string, string> {
  const linked = new Map<string, string>();
  for (const message of messages) {
    if (message.info.role !== 'assistant' || (roots !== undefined && !roots.has(message.info.parentID ?? ''))) continue;
    for (const part of message.parts) {
      if (part.type !== 'tool' || part.state?.output === undefined) continue;
      for (const sessionId of part.state.output.match(SESSION_ID) ?? []) linked.set(sessionId, message.info.parentID ?? message.info.id);
    }
  }
  return linked;
}

function mergeSessions(retained: readonly ActivitySession[], discovered: readonly ActivitySession[]): readonly ActivitySession[] {
  const merged = new Map(retained.map((session) => [session.id, session]));
  for (const session of discovered) merged.set(session.id, session);
  return [...merged.values()].slice(0, MAX_ACTIVITY_SESSIONS - 1);
}

export class OpenCodeActivity {
  readonly client: OpenCodeClient;
  constructor(client: OpenCodeClient) { this.client = client; }

  async observe(ctx: CallContext, binding: Binding, rootMessages: readonly NativeMessage[]): Promise<ActivityObservation> {
    const attempt = binding.attempt;
    if (!attempt) return { phase: 'unknown', sessions: [], limitations: [] };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    ctx.signal?.addEventListener('abort', cancel, { once: true });
    if (ctx.signal?.aborted) cancel();
    const timer = setTimeout(cancel, ACTIVITY_DEADLINE_MS);
    const activityContext = { ...ctx, signal: controller.signal };
    const retained = attempt.activitySessions;
    const discovered: ActivitySession[] = [];
    const limitations: string[] = [];
    let coverageComplete = true;
    let statuses: Awaited<ReturnType<OpenCodeClient['statuses']>> = {};
    try {
      statuses = await this.client.statuses(activityContext);
      const roots = new Set(attempt.messageIds);
      if ([...roots].some((root) => !rootMessages.some((message) => message.info.id === root))) {
        coverageComplete = false;
        limitations.push('An owned input root is outside the retained native message window.');
      }
      let frontier = [{ id: binding.nativeId, messages: rootMessages, rootMessageId: attempt.messageId }];
      const visited = new Set<string>();
      for (let depth = 0; depth < MAX_ACTIVITY_DEPTH && frontier.length > 0; depth += 1) {
        const next: typeof frontier = [];
        for (const current of frontier) {
          if (visited.size >= MAX_ACTIVITY_SESSIONS) {
            coverageComplete = false;
            limitations.push('Native activity exceeded the bounded session traversal.');
            break;
          }
          visited.add(current.id);
          const children = await this.client.children(activityContext, current.id);
          const links = linkedChildren(current.messages, current.id === binding.nativeId ? roots : undefined);
          const affiliated = children.filter((child) => links.has(child.id));
          if ([...links.keys()].some((id) => !children.some((child) => child.id === id))) {
            coverageComplete = false;
            limitations.push('An affiliated tool-linked child is absent from the current native child projection.');
          }
          const retainedChildren = retained.filter((child) => child.parentId === current.id);
          if (retainedChildren.some((child) => !children.some((native) => native.id === child.id))) {
            coverageComplete = false;
            limitations.push('A retained affiliated child is absent from the current native child projection.');
          }
          const capacity = MAX_ACTIVITY_SESSIONS - visited.size - next.length;
          if (affiliated.length > capacity) {
            coverageComplete = false;
            limitations.push('Native activity exceeded the bounded session traversal.');
          }
          for (const child of affiliated.slice(0, Math.max(0, capacity))) {
            const rootMessageId = links.get(child.id) ?? current.rootMessageId;
            discovered.push({ id: child.id, parentId: current.id, rootMessageId });
            next.push({ id: child.id, messages: await this.client.messages(activityContext, child.id), rootMessageId });
          }
        }
        frontier = next;
        if (depth === MAX_ACTIVITY_DEPTH - 1 && frontier.length > 0) {
          coverageComplete = false;
          limitations.push('Native activity exceeded the bounded ancestry depth.');
        }
      }
    } catch (error) {
      if (!(error instanceof HubError)) throw error;
      coverageComplete = false;
      limitations.push('Native child or status coverage is temporarily unavailable.');
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', cancel);
    }
    const sessions = mergeSessions(retained, discovered);
    const relatedIds = [binding.nativeId, ...sessions.map((session) => session.id)];
    const active = relatedIds.some((id) => statuses[id]?.type === 'busy' || statuses[id]?.type === 'retry');
    return { phase: active ? 'running' : coverageComplete ? 'idle' : 'unknown', sessions, limitations };
  }
}
