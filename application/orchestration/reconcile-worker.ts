import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { InteractionRepository } from "../persistence/interaction-repository.ts";
import type { ResultRepository } from "../persistence/result-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { RuntimeEventReconciler } from "./runtime-event-reconciler.ts";
import { runtimeTarget } from "./runtime-codec.ts";

export class ReconcileWorker {
  private readonly events: RuntimeEventReconciler;
  private readonly input: {
    readonly connectors: ConnectorRegistry; readonly state: StateRepository;
    readonly execution: ExecutionRepository; readonly interactions: InteractionRepository;
    readonly results: ResultRepository;
  };

  constructor(input: ReconcileWorker["input"]) {
    this.input = input;
    this.events = new RuntimeEventReconciler({
      state: input.state, execution: input.execution,
      interactions: input.interactions, results: input.results,
    });
  }

  async run(limit: number): Promise<number> {
    const bindings = this.input.state.runtimeBindings().slice(0, limit);
    for (const binding of bindings) {
      try {
        await this.reconcileBinding(binding);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        this.input.state.markSessionUnreachable(binding.workspaceId, binding.sessionId);
      }
    }
    return bindings.length;
  }

  private async reconcileBinding(binding: {
    readonly workspaceId: string; readonly sessionId: string; readonly generation: number;
    readonly descriptor: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const session = this.input.execution.getSession(binding.workspaceId, binding.sessionId);
    if (session.lifecycle === "closed") return;
    const connector = this.input.connectors.runtime(session.runtimeInstallationId);
    const target = runtimeTarget(binding.descriptor, {
      sessionId: session.id, generation: binding.generation,
    });
    const context = { workspaceId: binding.workspaceId,
      installationId: session.runtimeInstallationId, correlationId: `reconcile:${session.id}` };
    const observation = await connector.inspectSession(context, target);
    if (!this.sameNativeReference(target.nativeSession, observation.value.nativeSession)) return;
    if (observation.value.exists === false) {
      this.input.state.markSessionUnreachable(binding.workspaceId, binding.sessionId);
      return;
    }
    if (session.activeAttemptId !== undefined) {
      this.events.applyExecution(binding.workspaceId, session.activeAttemptId, observation.value.execution);
    }
    const after = this.input.state.lastOutputCursor(session.id);
    const output = await connector.readOutput(context, {
      target, ...(after === undefined ? {} : { after }), limit: 1000,
    });
    for (const item of output.items) {
      this.input.state.saveOutput({ workspaceId: binding.workspaceId, sessionId: session.id,
        ...(item.hubAttemptId === undefined ? {} : { attemptId: item.hubAttemptId }),
        bindingGeneration: binding.generation,
        ...(item.sourceItemId === undefined ? {} : { sourceItemId: item.sourceItemId }), item });
    }
    if (connector.subscribe === undefined) return;
    for await (const event of connector.subscribe(context, {
      target, ...(after === undefined ? {} : { after }),
    })) {
      this.events.apply(binding.workspaceId, session.id, session.runtimeInstallationId, event);
    }
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
