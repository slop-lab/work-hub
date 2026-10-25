import { z } from "zod";

import { InputReceiptSchema } from "../contracts/index.ts";
import type { InteractionRepository } from "../persistence/interaction-repository.ts";
import type { OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { RuntimeDeliveryWorker } from "./runtime-delivery-worker.ts";
import type { RuntimeSessionWorker } from "./runtime-session-worker.ts";

export class RuntimeOperationReducer {
  private readonly input: {
    readonly state: StateRepository;
    readonly interactions: InteractionRepository;
    readonly delivery: RuntimeDeliveryWorker;
    readonly sessions: RuntimeSessionWorker;
  };

  constructor(input: RuntimeOperationReducer["input"]) {
    this.input = input;
  }

  applyLookup(item: OutboxItem, result: unknown): void {
    switch (item.operationKind) {
      case "runtime.startAttempt": {
        const payload = z.strictObject({ attemptId: z.string() }).passthrough().parse(item.payload);
        const receipt = InputReceiptSchema.parse(result);
        if (receipt.nativeExecutionRef !== undefined) {
          this.input.state.saveAttemptNativeExecution(
            item.workspaceId, payload.attemptId, receipt.nativeExecutionRef,
          );
        }
        return;
      }
      case "runtime.sendInstruction": return;
      case "runtime.deliverResponse": {
        const payload = z.strictObject({ responseId: z.string() }).passthrough().parse(item.payload);
        this.input.interactions.updateDelivery(payload.responseId, "acknowledged", { result });
        return;
      }
      case "runtime.requestStop": {
        const payload = z.strictObject({ attemptId: z.string() }).passthrough().parse(item.payload);
        const effect = z.strictObject({ effect: z.union([
          z.literal("request_accepted"), z.literal("work_termination_confirmed"),
          z.literal("process_termination_confirmed"),
        ]) }).parse(result).effect;
        if (effect !== "request_accepted") {
          this.input.state.finishAttempt(item.workspaceId, payload.attemptId, "canceled");
        }
        return;
      }
      case "session.attachExisting": this.input.sessions.applyLookup(item, result); return;
      case "runtime.requestControl": this.input.sessions.applyLookup(item, result); return;
      case "runtime.detachSession": {
        const payload = z.strictObject({ sessionId: z.string(),
          observedAttemptId: z.string().optional() }).parse(item.payload);
        this.input.state.closeSession(
          item.workspaceId, payload.sessionId, payload.observedAttemptId,
        );
        return;
      }
      default: throw new TypeError(`Unsupported runtime lookup stage ${item.operationKind}.`);
    }
  }

  applyFailure(item: OutboxItem, receipt: object): void {
    switch (item.operationKind) {
      case "runtime.startAttempt": {
        const payload = z.strictObject({ attemptId: z.string() }).passthrough().parse(item.payload);
        this.input.state.finishAttempt(item.workspaceId, payload.attemptId, "failed");
        return;
      }
      case "runtime.deliverResponse": this.input.delivery.applyFailure(item, receipt); return;
      case "session.attachExisting": {
        const payload = z.strictObject({ sessionId: z.string() }).passthrough().parse(item.payload);
        this.input.state.closeSession(item.workspaceId, payload.sessionId);
        return;
      }
      case "runtime.sendInstruction":
      case "runtime.requestStop":
      case "runtime.requestControl":
      case "runtime.detachSession": return;
      default: throw new TypeError(`Unsupported runtime failure stage ${item.operationKind}.`);
    }
  }
}
