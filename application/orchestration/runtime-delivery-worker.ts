import { z } from "zod";

import {
  RequestValiditySchema,
  type Answer,
  type OperationReceipt,
  type RequestValidity,
  type ResponseDelivery,
} from "../contracts/index.ts";
import { answerValueSchema } from "../domain/schema-common.ts";
import type { InteractionRepository } from "../persistence/interaction-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import { actionContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { nativeRef } from "./runtime-codec.ts";

export class RuntimeDeliveryWorker {
  private readonly connectors: ConnectorRegistry;
  private readonly operations: OperationRepository;
  private readonly interactions: InteractionRepository;

  constructor(
    connectors: ConnectorRegistry,
    operations: OperationRepository,
    interactions: InteractionRepository,
  ) {
    this.connectors = connectors;
    this.operations = operations;
    this.interactions = interactions;
  }

  async deliver(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({
      requestId: z.string(), requestRevision: z.number(), responseId: z.string(),
      responseDigest: z.string(), answer: answerValueSchema,
      validity: z.record(z.string(), z.unknown()),
    }).parse(item.payload);
    const validity = RequestValiditySchema.parse(payload.validity);
    if (!this.interactions.deliveryAllowed(item.workspaceId, payload.requestId, payload.responseId)) {
      this.suppress(item, payload.responseId, "request_target_stale");
      return;
    }
    if (validity.kind !== "attempt") {
      this.suppress(item, payload.responseId, "request_target_stale");
      return;
    }
    if (validity.nativeRequestRef === undefined) {
      this.operations.markOutbox(item.id, "done", { status: "rejected", code: "native_request_missing" });
      this.interactions.updateDelivery(payload.responseId, "rejected", { code: "native_request_missing" });
      return;
    }
    const target = {
      hubSessionId: validity.target.hubSessionId,
      nativeSession: nativeRef(validity.target.nativeSession),
      bindingGeneration: validity.target.bindingGeneration,
      controlGrantRef: validity.target.controlGrantRef,
      hubAttemptId: validity.target.hubAttemptId,
      ...(validity.target.nativeExecutionRef === undefined ? {} : {
        nativeExecutionRef: nativeRef(validity.target.nativeExecutionRef),
      }),
    };
    const contractValidity: RequestValidity = {
      kind: "attempt", target,
      ...(validity.expiresAt === undefined ? {} : { expiresAt: validity.expiresAt }),
      nativeRequestRef: nativeRef(validity.nativeRequestRef),
      ...(validity.nativeRequestRevision === undefined ? {} : { nativeRequestRevision: validity.nativeRequestRevision }),
      ...(validity.actionDigest === undefined ? {} : { actionDigest: validity.actionDigest }),
      ...(validity.policyRevision === undefined ? {} : { policyRevision: validity.policyRevision }),
      ...(validity.environmentIdentities === undefined ? {} : {
        environmentIdentities: validity.environmentIdentities,
      }),
    };
    const input: ResponseDelivery = {
      target, requestId: payload.requestId, requestRevision: payload.requestRevision,
      responseId: payload.responseId, responseDigest: payload.responseDigest,
      nativeRequestRef: validity.nativeRequestRef, answer: this.answer(payload.answer),
      validity: contractValidity,
    };
    const receipt = await this.connectors.runtime(item.installationId)
      .deliverResponse(actionContext(item, [validity.target.controlGrantRef]), input);
    this.settle(item, receipt, () => {
      this.interactions.updateDelivery(payload.responseId, "acknowledged", receipt);
    }, () => this.interactions.updateDelivery(payload.responseId, "unknown", receipt));
  }

  private suppress(item: OutboxItem, responseId: string, code: string): void {
    this.interactions.updateDelivery(responseId, "suppressed", { code });
    this.operations.markOutbox(item.id, "done", { status: "rejected", code });
  }

  private answer(input: z.infer<typeof answerValueSchema>): Answer {
    switch (input.kind) {
      case "text": return { kind: "text", text: input.text };
      case "single_choice": return { kind: "single_choice", optionId: input.optionId };
      case "approval": return { kind: "approval", decision: input.decision,
        ...(input.note === undefined ? {} : { note: input.note }) };
    }
  }

  private settle<T>(
    item: OutboxItem,
    receipt: OperationReceipt<T>,
    confirmed: (result: T) => void,
    uncertain: () => void,
  ): void {
    switch (receipt.status) {
      case "confirmed": this.operations.settleConfirmed(item.id, receipt, () => confirmed(receipt.result)); return;
      case "accepted":
      case "running":
      case "unknown": uncertain(); this.operations.markForLookup(item.id, receipt); return;
      case "rejected":
      case "failed": this.operations.markOutbox(item.id, "done", receipt); return;
    }
  }
}
