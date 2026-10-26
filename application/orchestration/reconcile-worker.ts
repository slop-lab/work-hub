import type {
  BindingObservation,
  CallContext,
  EnvironmentAttachment,
  ResourceIdentity,
  RuntimeEvent,
} from "../contracts/index.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { InteractionRepository } from "../persistence/interaction-repository.ts";
import type { ObservationRepository } from "../persistence/observation-repository.ts";
import type { ResultRepository } from "../persistence/result-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { RuntimeEventReconciler } from "./runtime-event-reconciler.ts";
import { runtimeTarget } from "./runtime-codec.ts";
import { digest } from '../persistence/codec.ts';

const subscriptionEnded = Symbol("subscription-ended");

class ObservationReadTimeoutError extends Error {
  readonly name = "ObservationReadTimeoutError";
}

export class ReconcileWorker {
  private readonly events: RuntimeEventReconciler;
  private readonly input: {
    readonly connectors: ConnectorRegistry; readonly state: StateRepository;
    readonly observation: ObservationRepository;
    readonly execution: ExecutionRepository; readonly interactions: InteractionRepository;
    readonly results: ResultRepository; readonly subscriptionBudgetMs?: number;
    readonly maxEventsPerBinding?: number; readonly readBudgetMs?: number;
  };
  private runtimeCursor: string | undefined;
  private environmentCursor: string | undefined;

  constructor(input: ReconcileWorker["input"]) {
    this.input = input;
    this.events = new RuntimeEventReconciler({
      state: input.state, execution: input.execution,
      interactions: input.interactions, results: input.results,
    });
  }

  async run(limit: number): Promise<number> {
    const bindings = this.input.observation.runtimeBindings({ limit, ...(this.runtimeCursor === undefined
      ? {} : { after: this.runtimeCursor }) });
    for (const binding of bindings) {
      try {
        await this.reconcileBinding(binding);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        this.input.state.markSessionUnreachable(binding.workspaceId, binding.sessionId);
      }
    }
    this.runtimeCursor = bindings.at(-1)?.sessionId ?? this.runtimeCursor;
    const environments = this.input.observation.environmentBindings({ limit,
      ...(this.environmentCursor === undefined ? {} : { after: this.environmentCursor }) });
    for (const environment of environments) await this.reconcileEnvironment(environment);
    this.environmentCursor = environments.at(-1)?.bindingId ?? this.environmentCursor;
    return bindings.length + environments.length;
  }

  private async reconcileBinding(binding: {
    readonly workspaceId: string; readonly sessionId: string; readonly generation: number;
    readonly descriptor: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const session = this.input.execution.getSession(binding.workspaceId, binding.sessionId);
    const connector = this.input.connectors.runtime(session.runtimeInstallationId);
    const target = runtimeTarget(binding.descriptor, {
      sessionId: session.id, generation: binding.generation,
    });
    const context = { workspaceId: binding.workspaceId,
      installationId: session.runtimeInstallationId, correlationId: `reconcile:${session.id}` };
    const observation = await this.boundedRead(context,
      (boundedContext) => connector.inspectSession(boundedContext, target));
    if (!this.sameNativeReference(target.nativeSession, observation.value.nativeSession)) {
      this.input.state.markSessionUnreachable(binding.workspaceId, binding.sessionId);
      return;
    }
    if (observation.value.exists === false || observation.value.controlGrantValid === false) {
      this.input.state.markSessionUnreachable(binding.workspaceId, binding.sessionId);
      return;
    }
    if (session.activeAttemptId !== undefined && (observation.value.execution.hubAttemptId === undefined ||
      observation.value.execution.hubAttemptId === session.activeAttemptId)) {
      this.events.applyExecution(binding.workspaceId, session.activeAttemptId, observation.value.execution);
    }
    const cursors = this.input.observation.observationCursors(binding.workspaceId, session.id);
    const output = await this.boundedRead(context, (boundedContext) => connector.readOutput(
      boundedContext,
      { target, ...(cursors.output === undefined ? {} : { after: cursors.output }), limit: 1_000 },
    ));
    this.input.observation.saveOutputPage({ workspaceId: binding.workspaceId, sessionId: session.id,
      bindingGeneration: binding.generation, items: [...output.gaps.map((gap) => ({
        ...(session.activeAttemptId === undefined ? {} : { attemptId: session.activeAttemptId }),
        sourceItemId: `history-gap:${session.activeAttemptId ?? 'session'}:${digest(gap)}`,
        item: { kind: 'gap', role: 'runtime', text: gap.reason, observedAt: observation.observedAt },
      })), ...output.items.map((item) => ({
        ...(item.hubAttemptId === undefined ? {} : { attemptId: item.hubAttemptId }),
        ...(item.sourceItemId === undefined ? {} : { sourceItemId: item.sourceItemId }), item,
      }))], ...(output.nextCursor === undefined ? {} : { nextCursor: output.nextCursor }) });
    if (connector.subscribe === undefined) return;
    await this.consumeSubscription(connector.subscribe.bind(connector), context, target, cursors.events,
      binding.workspaceId, session.id);
  }

  private async consumeSubscription(
    subscribe: NonNullable<ReturnType<ConnectorRegistry["runtime"]>["subscribe"]>,
    context: CallContext,
    target: ReturnType<typeof runtimeTarget>,
    after: string | undefined,
    workspaceId: string,
    sessionId: string,
  ): Promise<void> {
    const budgetMs = this.input.subscriptionBudgetMs ?? 50;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const deadlineAt = new Date(Date.now() + budgetMs).toISOString();
    const iterator = subscribe({ ...context, deadlineAt, signal: controller.signal }, {
      target, ...(after === undefined ? {} : { after }),
    })[Symbol.asyncIterator]();
    try {
      for (let count = 0; count < (this.input.maxEventsPerBinding ?? 100); count += 1) {
        const item = await this.nextEvent(iterator, controller.signal);
        if (item === subscriptionEnded || item.done) return;
        this.events.apply(workspaceId, sessionId, context.installationId, item.value);
        if (item.value.sourceCursor !== undefined) {
          this.input.observation.saveEventCursor(workspaceId, sessionId, item.value.sourceCursor);
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      const close = iterator.return?.();
      if (close !== undefined) void close.catch(() => undefined);
    }
  }

  private nextEvent(
    iterator: AsyncIterator<RuntimeEvent>,
    signal: AbortSignal,
  ): Promise<IteratorResult<RuntimeEvent> | typeof subscriptionEnded> {
    if (signal.aborted) return Promise.resolve(subscriptionEnded);
    return new Promise((resolve, reject) => {
      const finish = () => resolve(subscriptionEnded);
      signal.addEventListener("abort", finish, { once: true });
      iterator.next().then((item) => {
        signal.removeEventListener("abort", finish);
        resolve(item);
      }, (error: unknown) => {
        signal.removeEventListener("abort", finish);
        reject(error);
      });
    });
  }

  private async reconcileEnvironment(binding: {
    readonly workspaceId: string; readonly bindingId: string; readonly sessionId: string;
    readonly attemptId?: string; readonly attachment: EnvironmentAttachment;
  }): Promise<void> {
    try {
      const connector = this.input.connectors.execution(binding.attachment.attachmentRef.installationId);
      const context = { workspaceId: binding.workspaceId,
        installationId: binding.attachment.attachmentRef.installationId,
        correlationId: `reconcile-environment:${binding.bindingId}` };
      const observation = await this.boundedRead(context,
        (boundedContext) => connector.inspectBinding(boundedContext, binding.attachment));
      const safety = this.environmentSafety(binding.attachment, observation.value);
      this.input.observation.saveEnvironmentObservation({ workspaceId: binding.workspaceId,
        bindingId: binding.bindingId, observation: observation.value, safety });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.input.observation.saveEnvironmentObservation({ workspaceId: binding.workspaceId,
        bindingId: binding.bindingId, observation: { message: error.message }, safety: "unreachable" });
    }
  }

  private environmentSafety(
    attachment: EnvironmentAttachment,
    observation: BindingObservation,
  ): "fresh" | "stale" | "unsafe" {
    if (!this.sameIdentity(attachment.identity, observation.identity) || observation.state === "missing" ||
      observation.state === "stopped" || observation.attachmentValid === false ||
      observation.grantValid === false) return "unsafe";
    if (observation.state === "unknown" || observation.attachmentValid === "unknown" ||
      observation.grantValid === "unknown") return "stale";
    return "fresh";
  }

  private async boundedRead<T>(
    context: CallContext,
    read: (boundedContext: CallContext) => Promise<T>,
  ): Promise<T> {
    const budgetMs = this.input.readBudgetMs ?? 1_000;
    const controller = new AbortController();
    const deadlineAt = new Date(Date.now() + budgetMs).toISOString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ObservationReadTimeoutError(`Observation read exceeded ${budgetMs}ms.`));
      }, budgetMs);
    });
    try {
      return await Promise.race([read({ ...context, deadlineAt, signal: controller.signal }), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  private sameIdentity(expected: ResourceIdentity, actual: ResourceIdentity): boolean {
    return this.sameNativeReference(expected.native, actual.native) && expected.assurance === actual.assurance &&
      expected.continuityToken === actual.continuityToken;
  }

  private sameNativeReference(
    expected: { readonly installationId: string; readonly providerScope: string; readonly kind: string;
      readonly id: string; readonly incarnation?: string | undefined },
    actual: { readonly installationId: string; readonly providerScope: string; readonly kind: string;
      readonly id: string; readonly incarnation?: string | undefined },
  ): boolean {
    return expected.installationId === actual.installationId &&
      expected.providerScope === actual.providerScope && expected.kind === actual.kind &&
      expected.id === actual.id && expected.incarnation === actual.incarnation;
  }
}
