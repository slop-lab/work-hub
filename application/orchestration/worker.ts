import { assertNever } from "../domain/assert-never.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import { LeaseLostError, withOutboxLease } from "../persistence/outbox-lease.ts";
import { callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import type { DelegationWorker } from "./delegation-worker.ts";
import type { ExecutionWorker } from "./execution-worker.ts";
import type { ReconcileWorker } from "./reconcile-worker.ts";
import type { RuntimeWorker } from "./runtime-worker.ts";
import { validatedLookupReceipt } from "./operation-receipt-validation.ts";

export class OrchestrationWorker {
  private readonly connectors: ConnectorRegistry;
  private readonly operations: OperationRepository;
  private readonly delegation: DelegationWorker;
  private readonly runtime: RuntimeWorker;
  private readonly execution: ExecutionWorker;
  private readonly reconciliation: ReconcileWorker;
  private readonly terminalFailure: (item: OutboxItem, receipt: object) => void;

  constructor(input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly delegation: DelegationWorker; readonly runtime: RuntimeWorker;
    readonly execution: ExecutionWorker; readonly reconciliation: ReconcileWorker;
    readonly terminalFailure?: (item: OutboxItem, receipt: object) => void;
  }) {
    this.connectors = input.connectors;
    this.operations = input.operations;
    this.delegation = input.delegation;
    this.runtime = input.runtime;
    this.execution = input.execution;
    this.reconciliation = input.reconciliation;
    this.terminalFailure = input.terminalFailure ?? ((item, receipt) => {
      switch (item.operationKind) {
        case "delegation.advance":
        case "execution.attachForDelegation":
        case "session.attachEnvironment":
        case "runtime.openForDelegation":
          this.delegation.applyFailure(item);
          return;
        case "runtime.startAttempt":
        case "runtime.sendInstruction":
        case "runtime.deliverResponse":
        case "runtime.requestStop":
        case "session.attachExisting":
        case "runtime.requestControl":
        case "runtime.detachSession":
          this.runtime.applyFailure(item, receipt);
          return;
        case "execution.detachAttachment":
        case "execution.releaseAllocation":
        case "execution.cancelOperation":
        case "execution.releaseCanceledAllocation":
        case "execution.detachCanceledAttachment":
          this.execution.applyFailure(item);
          return;
        default:
          throw new TypeError(`No terminal failure handler for ${item.operationKind}.`);
      }
    });
  }

  async drain(input: { readonly limit?: number } = {}): Promise<number> {
    const items = this.operations.claimDue(input.limit ?? 100);
    for (const item of items) {
      try {
        await withOutboxLease(item, () => {
          this.operations.assertOwned(item.id);
          return this.process(item);
        });
      } catch (error) {
        if (error instanceof LeaseLostError) continue;
        try {
          withOutboxLease(item, () => {
            if (this.isReadOnlyRetry(item)) {
              this.operations.markOutbox(item.id, "pending");
              return;
            }
            this.operations.markForLookup(item.id, {
              status: "unknown",
              code: "worker_exception",
              message: error instanceof Error ? error.message : "Unknown worker failure.",
              reconciliationHint: "Inspect the original operation ID before replaying any side effect.",
            });
          });
        } catch (settlementError) {
          if (!(settlementError instanceof LeaseLostError)) throw settlementError;
        }
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
      case "runtime.detachSession": await this.runtime.detachSession(item); return;
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
        const receipt = validatedLookupReceipt(item, lookup.receipt);
        switch (receipt.status) {
          case "confirmed":
            this.operations.settleConfirmed(item.id, receipt,
              () => this.applyLookup(item, receipt.result));
            return;
          case "accepted":
          case "running":
          case "unknown":
            this.operations.markForLookup(item.id, receipt);
            return;
          case "rejected":
          case "failed":
            this.operations.settleTerminal(item.id, receipt.status, receipt,
              () => this.terminalFailure(item, receipt));
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
    const originalItem = {
        id: item.id, leaseToken: item.leaseToken,
        workspaceId: original.workspaceId, operationId: original.id,
        commandId: original.commandId, connectorKind: original.connectorKind,
        installationId: original.installationId, inputDigest: original.inputDigest,
        operationKind: original.operationKind,
        ...(original.targetId === undefined ? {} : { targetId: original.targetId }),
        ...(original.targetGeneration === undefined ? {} : { targetGeneration: original.targetGeneration }),
        workType: original.operationKind, payload: original.payload, attempts: item.attempts,
      };
    const receipt = validatedLookupReceipt(originalItem, lookup.receipt);
    switch (receipt.status) {
      case "confirmed":
        this.operations.settleReconciliation({
          originalOperationId: original.id, reconciliationOutboxId: item.id,
          status: "confirmed", receipt, apply: () => this.applyLookup(originalItem, receipt.result),
        });
        return;
      case "rejected":
      case "failed":
        this.operations.settleReconciliation({
          originalOperationId: original.id, reconciliationOutboxId: item.id,
          status: receipt.status, receipt, apply: () => this.terminalFailure(originalItem, receipt),
        });
        return;
      case "accepted":
      case "running":
      case "unknown":
        this.operations.settleReconciliation({
          originalOperationId: original.id, reconciliationOutboxId: item.id,
          status: "unknown", receipt, apply: () => {},
        });
        return;
      default: return assertNever(receipt);
    }
  }

  private applyLookup(item: OutboxItem, result: unknown): void {
    switch (item.operationKind) {
      case "delegation.advance":
      case "execution.attachForDelegation":
      case "session.attachEnvironment":
      case "runtime.openForDelegation":
        this.delegation.applyLookup(item, result);
        return;
      case "runtime.startAttempt":
      case "runtime.sendInstruction":
      case "runtime.deliverResponse":
      case "runtime.requestStop":
      case "session.attachExisting":
      case "runtime.requestControl":
      case "runtime.detachSession":
        this.runtime.applyLookup(item, result);
        return;
      case "execution.detachAttachment":
      case "execution.releaseAllocation":
      case "execution.cancelOperation":
      case "execution.releaseCanceledAllocation":
      case "execution.detachCanceledAttachment":
        this.execution.applyLookup(item);
        return;
      default:
        throw new TypeError(`No lookup result handler for ${item.operationKind}.`);
    }
  }

  private isReadOnlyRetry(item: OutboxItem): boolean {
    if (item.workType === "execution.probeExisting" || item.workType === 'operation.reconcile') return true;
    if (item.workType !== "delegation.advance") return false;
    const environment = Reflect.get(item.payload, "environment");
    return typeof environment === "object" && environment !== null &&
      Reflect.get(environment, "mode") === "existing";
  }

}
