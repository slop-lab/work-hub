import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { DelegationAttachmentWorker } from "./delegation-attachment-worker.ts";
import { DelegationPreparationWorker } from "./delegation-preparation-worker.ts";
import { DelegationSessionWorker } from "./delegation-session-worker.ts";

export class DelegationWorker {
  private readonly preparation: DelegationPreparationWorker;
  private readonly attachment: DelegationAttachmentWorker;
  private readonly session: DelegationSessionWorker;

  constructor(input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly environments: EnvironmentRepository; readonly execution: ExecutionRepository;
    readonly state: StateRepository;
  }) {
    this.session = new DelegationSessionWorker(input);
    this.preparation = new DelegationPreparationWorker({
      ...input,
      bindAndStart: (item, delegation, result) => this.session.bindAndStart(item, delegation, result),
    });
    this.attachment = new DelegationAttachmentWorker(input);
  }

  async advance(item: OutboxItem): Promise<void> { await this.preparation.advance(item); }
  async attach(item: OutboxItem): Promise<void> { await this.attachment.attach(item); }
  async open(item: OutboxItem): Promise<void> { await this.session.open(item); }
  async attachSessionEnvironment(item: OutboxItem): Promise<void> {
    await this.attachment.attachSessionEnvironment(item);
  }

  applyLookup(item: OutboxItem, result: unknown): void {
    switch (item.operationKind) {
      case "delegation.advance": this.preparation.applyLookup(item, result); return;
      case "execution.attachForDelegation": this.attachment.applyLookup(item, result); return;
      case "runtime.openForDelegation": this.session.applyLookup(item, result); return;
      default: throw new TypeError(`Unsupported delegation lookup stage ${item.operationKind}.`);
    }
  }
}
