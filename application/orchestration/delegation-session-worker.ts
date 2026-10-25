import { z } from "zod";

import { EnvironmentAttachmentSchema, OpenSessionInputSchema } from "../contracts/index.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import { digest } from "../persistence/codec.ts";
import { actionContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { bindingDescriptorSchema } from "./runtime-codec.ts";
import { delegationSchema, type DelegationPayload } from "./delegation-schema.ts";

export class DelegationSessionWorker {
  private readonly input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly execution: ExecutionRepository; readonly state: StateRepository;
  };

  constructor(input: DelegationSessionWorker["input"]) { this.input = input; }

  async open(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({ delegation: delegationSchema,
      attachment: EnvironmentAttachmentSchema,
      route: z.strictObject({ id: z.string(), ownerInstallationId: z.string(),
        kind: z.string(), expiresAt: z.string().optional() }) }).parse(item.payload);
    const profile = this.input.execution.getProfile(item.workspaceId,
      payload.delegation.profileId, payload.delegation.profileRevision);
    if (this.input.state.stopRequested(item.workspaceId, payload.delegation.attemptId)) {
      const localReceipt = { status: "confirmed", effect: "attempt.canceled_before_session_open" };
      this.input.operations.settleConfirmed(item.id, localReceipt, () => {
        this.enqueueAttachmentCleanup(item, payload.delegation, payload.attachment);
        this.input.state.finishAttempt(item.workspaceId, payload.delegation.attemptId, "canceled");
      });
      return;
    }
    const open = OpenSessionInputSchema.parse({ hubSessionId: payload.delegation.sessionId,
      route: { kind: "environment", attachment: payload.attachment, route: payload.route },
      configuration: profile.configuration, requestedControl: "control",
      ...(payload.delegation.precreatedNativeSession ? { mode: 'attach', nativeSession: payload.delegation.precreatedNativeSession, sessionLaunchOwner: 'execution_provider' } : { mode: 'create', sessionLaunchOwner: 'runtime_connector' }) });
    const receipt = await this.input.connectors.runtime(item.installationId)
      .openSession(actionContext(item), open);
    if (receipt.status === "rejected" || receipt.status === "failed") {
      this.input.operations.settleTerminal(item.id, receipt.status, receipt, () => {
        this.enqueueAttachmentCleanup(item, payload.delegation, payload.attachment);
        this.input.state.finishAttempt(item.workspaceId, payload.delegation.attemptId, "failed");
        this.input.state.closeSession(item.workspaceId, payload.delegation.sessionId);
      });
      return;
    }
    switch (receipt.status) {
      case "confirmed": this.input.operations.settleConfirmed(item.id, receipt,
        () => this.bindAndStart(item, payload.delegation, receipt.result)); return;
      case "accepted":
      case "running":
      case "unknown": this.input.operations.markForLookup(item.id, receipt); return;
    }
  }

  bindAndStart(item: OutboxItem, delegation: DelegationPayload, descriptorInput: unknown): void {
    const descriptor = bindingDescriptorSchema.parse(descriptorInput);
    this.input.state.bindRuntime({ workspaceId: item.workspaceId,
      sessionId: delegation.sessionId, nativeIdentityKey: JSON.stringify(descriptor.nativeSession),
      capabilities: descriptor.capabilities, descriptor, generation: 1 });
    const payload = { sessionId: delegation.sessionId, attemptId: delegation.attemptId,
      descriptor, inputSnapshot: delegation.inputSnapshot,
      workAreas: delegation.environment.mode === "none" ? [] : delegation.environment.workAreas };
    this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
      workType: "runtime.startAttempt", connectorKind: "runtime",
      installationId: descriptor.nativeSession.installationId, stage: "start_attempt",
      targetId: delegation.attemptId, targetGeneration: 1,
      payload, inputDigest: digest(payload) });
  }

  applyLookup(item: OutboxItem, result: unknown): void {
    const payload = z.strictObject({ delegation: delegationSchema,
      attachment: EnvironmentAttachmentSchema,
      route: z.record(z.string(), z.unknown()) }).parse(item.payload);
    this.bindAndStart(item, payload.delegation, result);
  }

  applyFailure(item: OutboxItem): void {
    const payload = z.strictObject({ delegation: delegationSchema,
      attachment: EnvironmentAttachmentSchema }).passthrough().parse(item.payload);
    this.enqueueAttachmentCleanup(item, payload.delegation, payload.attachment);
    this.input.state.finishAttempt(item.workspaceId, payload.delegation.attemptId, "failed");
    this.input.state.closeSession(item.workspaceId, payload.delegation.sessionId);
  }

  private enqueueAttachmentCleanup(
    item: OutboxItem, delegation: DelegationPayload,
    attachment: z.infer<typeof EnvironmentAttachmentSchema>,
  ): void {
    if (delegation.bindingId === undefined) throw new TypeError("Attachment cleanup requires its persisted binding ID.");
    const payload = { bindingId: delegation.bindingId, attachment };
    this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
      workType: "execution.detachCanceledAttachment", connectorKind: "execution",
      installationId: attachment.attachmentRef.installationId,
      stage: "detach_failed_session_attachment", targetId: delegation.bindingId,
      targetGeneration: attachment.hubBindingGeneration, payload, inputDigest: digest(payload) });
  }
}
