import { parseSerializedOperationReceipt } from "../contracts/index.ts";
import { assertNever } from "../domain/assert-never.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import { callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import type { DelegationWorker } from "./delegation-worker.ts";
import type { ExecutionWorker } from "./execution-worker.ts";
import type { ReconcileWorker } from "./reconcile-worker.ts";
import type { RuntimeWorker } from "./runtime-worker.ts";

export class OrchestrationWorker {
  private readonly connectors: ConnectorRegistry;
  private readonly operations: OperationRepository;
  private readonly delegation: DelegationWorker;
  private readonly runtime: RuntimeWorker;
  private readonly execution: ExecutionWorker;
  private readonly reconciliation: ReconcileWorker;

  constructor(input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly delegation: DelegationWorker; readonly runtime: RuntimeWorker;
    readonly execution: ExecutionWorker; readonly reconciliation: ReconcileWorker;
  }) {
    this.connectors = input.connectors;
    this.operations = input.operations;
    this.delegation = input.delegation;
    this.runtime = input.runtime;
    this.execution = input.execution;
    this.reconciliation = input.reconciliation;
  }

  async drain(input: { readonly limit?: number } = {}): Promise<number> {
    const items = this.operations.due(input.limit ?? 100);
    for (const item of items) {
      try {
        await this.process(item);
      } catch (error) {
        this.operations.markForLookup(item.id, {
          status: "unknown",
          code: "worker_exception",
          message: error instanceof Error ? error.message : "Unknown worker failure.",
          reconciliationHint: "Inspect the original operation ID before replaying any side effect.",
        });
      }
    }
    return items.length;
  }

  async reconcile(input: { readonly limit?: number } = {}): Promise<number> {
    const drained = await this.drain(input);
    const observed = await this.reconciliation.run(input.limit ?? 100);
    return drained + observed;
  }

  private async process(item: OutboxItem): Promise<void> {
    switch (item.workType) {
      case "delegation.advance": await this.delegation.advance(item); return;
      case "execution.attachForDelegation": await this.delegation.attach(item); return;
      case "runtime.openForDelegation": await this.delegation.open(item); return;
      case "session.attachEnvironment": await this.delegation.attachSessionEnvironment(item); return;
      case "runtime.startAttempt": await this.runtime.start(item); return;
      case "runtime.sendInstruction": await this.runtime.instruct(item); return;
      case "runtime.requestStop": await this.runtime.stop(item); return;
      case "runtime.deliverResponse": await this.runtime.deliver(item); return;
      case "session.attachExisting": await this.runtime.attachExisting(item); return;
      case "runtime.requestControl": await this.runtime.requestControl(item); return;
      case "execution.probeExisting": await this.execution.verify(item); return;
      case "execution.detachAttachment": await this.execution.detach(item); return;
      case "execution.releaseAllocation": await this.execution.release(item); return;
      case "execution.cancelOperation": await this.execution.cancel(item); return;
      case "execution.releaseCanceledAllocation": await this.execution.releaseCanceled(item); return;
      case "execution.detachCanceledAttachment": await this.execution.detachCanceled(item); return;
      case "operation.lookup": await this.lookup(item); return;
      case "operation.reconcile": await this.lookupExplicit(item); return;
      default:
        this.operations.markOutbox(item.id, "done", {
          status: "failed", code: "unknown_work_type", workType: item.workType,
        });
    }
  }

  private async lookup(item: OutboxItem): Promise<void> {
    if (item.operationId === undefined) throw new TypeError("Lookup job has no operation ID.");
    const connector = item.connectorKind === "execution"
      ? this.connectors.execution(item.installationId)
      : this.connectors.runtime(item.installationId);
    const lookup = await connector.lookupOperation(callContext(item), item.operationId);
    switch (lookup.kind) {
      case "found": {
        const receipt = parseSerializedOperationReceipt(lookup.receipt);
        switch (receipt.status) {
          case "confirmed":
            this.applyLookup(item, receipt.result);
            this.operations.markOutbox(item.id, "done", receipt);
            return;
          case "accepted":
          case "running":
          case "unknown":
            this.operations.markForLookup(item.id, receipt);
            return;
          case "rejected":
          case "failed":
            this.operations.markOutbox(item.id, "done", receipt);
            return;
          default: return assertNever(receipt);
        }
      }
      case "not_found":
        this.operations.markOutbox(item.id, "unknown", lookup);
        return;
      case "unsupported":
        this.operations.markOutbox(item.id, "unknown", lookup);
        return;
      default: return assertNever(lookup);
    }
  }

  private async lookupExplicit(item: OutboxItem): Promise<void> {
    const originalId = item.targetId;
    if (originalId === undefined) throw new TypeError("Explicit reconciliation is missing its target.");
    const original = this.operations.operation(item.workspaceId, originalId);
    if (original === undefined) throw new TypeError("Original operation is unavailable.");
    const connector = original.connectorKind === "execution"
      ? this.connectors.execution(original.installationId)
      : this.connectors.runtime(original.installationId);
    const lookup = await connector.lookupOperation({
      workspaceId: item.workspaceId, installationId: original.installationId,
      correlationId: item.commandId,
    }, original.id);
    if (lookup.kind !== "found") {
      this.operations.settleReconciliation({
        originalOperationId: original.id, reconciliationOutboxId: item.id,
        status: "unknown", receipt: lookup, apply: () => {},
      });
      return;
    }
    const receipt = parseSerializedOperationReceipt(lookup.receipt);
    const originalItem = {
        id: item.id, workspaceId: original.workspaceId, operationId: original.id,
        commandId: original.commandId, connectorKind: original.connectorKind,
        installationId: original.installationId, inputDigest: original.inputDigest,
        operationKind: original.operationKind,
        ...(original.targetId === undefined ? {} : { targetId: original.targetId }),
        ...(original.targetGeneration === undefined ? {} : { targetGeneration: original.targetGeneration }),
        workType: original.operationKind, payload: original.payload, attempts: item.attempts,
      };
    const status = receipt.status === "accepted" || receipt.status === "running"
      ? "unknown" : receipt.status;
    this.operations.settleReconciliation({
      originalOperationId: original.id, reconciliationOutboxId: item.id,
      status, receipt,
      apply: receipt.status === "confirmed"
        ? () => this.applyLookup(originalItem, receipt.result)
        : () => {},
    });
  }

  private applyLookup(item: OutboxItem, result: unknown): void {
    switch (item.operationKind) {
      case "delegation.advance":
      case "execution.attachForDelegation":
      case "runtime.openForDelegation":
        this.delegation.applyLookup(item, result);
        return;
      case "runtime.startAttempt":
      case "runtime.sendInstruction":
      case "runtime.deliverResponse":
      case "runtime.requestStop":
      case "session.attachExisting":
      case "runtime.requestControl":
        this.runtime.applyLookup(item, result);
        return;
      case "execution.detachAttachment":
      case "execution.releaseAllocation":
        this.execution.applyLookup(item);
        return;
      default:
        throw new TypeError(`No lookup result handler for ${item.operationKind}.`);
    }
  }
}
