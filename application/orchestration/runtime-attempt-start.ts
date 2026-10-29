import { z } from "zod";

import { InputSnapshotSchema, type AttemptStart, WorkAreaSchema } from "../contracts/index.ts";
import type { HandoffRepository } from "../persistence/handoff-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import { actionContext, callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { nativeExecutionTarget, runtimeInputSnapshot, runtimeWorkAreas } from "./runtime-attempt-codec.ts";
import { bindingDescriptorSchema, runtimeTarget } from "./runtime-codec.ts";

const startSchema = z.strictObject({
  sessionId: z.string(), attemptId: z.string(), descriptor: bindingDescriptorSchema.optional(),
  inputSnapshot: InputSnapshotSchema.optional(), input: InputSnapshotSchema.optional(),
  workAreas: z.array(WorkAreaSchema).default([]),
});

export class RuntimeAttemptStart {
  private readonly input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly state: StateRepository; readonly handoffs: HandoffRepository;
    readonly enqueueSessionDetach: (item: OutboxItem, sessionId: string) => void;
  };
  constructor(input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly state: StateRepository; readonly handoffs: HandoffRepository;
    readonly enqueueSessionDetach: (item: OutboxItem, sessionId: string) => void;
  }) { this.input = input; }

  async run(item: OutboxItem): Promise<void> {
    const payload = startSchema.parse(item.payload);
    if (this.input.state.stopRequested(item.workspaceId, payload.attemptId)) {
      this.input.operations.settleConfirmed(item.id, {
        status: "confirmed", effect: "attempt.canceled_before_input",
      }, () => {
        this.input.state.finishAttempt(item.workspaceId, payload.attemptId, "canceled");
        this.input.enqueueSessionDetach(item, payload.sessionId);
      });
      return;
    }
    const descriptor = payload.descriptor ?? bindingDescriptorSchema.parse(
      this.input.state.runtimeBinding(item.workspaceId, payload.sessionId));
    const snapshot = payload.inputSnapshot ?? payload.input;
    if (snapshot === undefined) throw new TypeError("Attempt start is missing its input snapshot.");
    const target = { ...runtimeTarget(descriptor, { sessionId: payload.sessionId,
      generation: item.targetGeneration ?? this.input.state.runtimeBindingRecord(
        item.workspaceId, payload.sessionId).generation }), hubAttemptId: payload.attemptId };
    const request: AttemptStart = {
      target, input: runtimeInputSnapshot(snapshot), workAreas: runtimeWorkAreas(payload.workAreas),
    };
    const receipt = await this.input.connectors.runtime(item.installationId)
      .startAttempt(actionContext(item, [descriptor.controlGrant.id]), request);
    if (receipt.status !== "confirmed") {
      switch (receipt.status) {
        case "accepted":
        case "running":
        case "unknown":
          this.input.handoffs.recordDelivery(item.workspaceId, payload.attemptId,
            { status: "unknown", receipt });
          this.input.operations.markForLookup(item.id, receipt);
          return;
        case "rejected":
        case "failed":
          this.input.operations.settleTerminal(item.id, receipt.status, receipt, () => {
            this.input.handoffs.recordDelivery(item.workspaceId, payload.attemptId,
              { status: "failed", error: receipt });
            this.input.state.finishAttempt(item.workspaceId, payload.attemptId, "failed");
          });
          return;
      }
    }
    const observation = await this.input.connectors.runtime(item.installationId).inspectSession(
      callContext(item), runtimeTarget(descriptor, { sessionId: payload.sessionId,
        generation: item.targetGeneration ?? 1 }));
    this.input.operations.settleConfirmed(item.id, receipt, () => {
      this.input.handoffs.recordDelivery(item.workspaceId, payload.attemptId,
        { status: "delivered", receipt: receipt.result });
      if (receipt.result.nativeExecutionRef !== undefined) {
        this.input.state.saveAttemptNativeExecution(item.workspaceId, payload.attemptId,
          receipt.result.nativeExecutionRef);
      }
      switch (observation.value.execution.phase) {
        case "running": this.input.state.setAttemptPhase(item.workspaceId, payload.attemptId, "running"); return;
        case "waiting_input": this.input.state.setAttemptPhase(item.workspaceId, payload.attemptId, "waiting_input"); return;
        case "idle":
        case "unknown":
        case "ended": return;
      }
    });
  }
}
