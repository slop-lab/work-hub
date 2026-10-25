import { z } from "zod";

import {
  InputSnapshotSchema,
  type AttemptStart,
  type InstructionInput,
  type OperationReceipt,
  type StopInput,
  WorkAreaSchema,
} from "../contracts/index.ts";
import type { AttemptFactory } from "../persistence/attempt-factory.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { InteractionRepository } from "../persistence/interaction-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import { digest } from "../persistence/codec.ts";
import { actionContext, callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import {
  bindingDescriptorSchema, runtimeTarget,
} from "./runtime-codec.ts";
import { RuntimeDeliveryWorker } from "./runtime-delivery-worker.ts";
import { RuntimeSessionWorker } from "./runtime-session-worker.ts";
import { nativeExecutionTarget, runtimeInputSnapshot, runtimeWorkAreas } from "./runtime-attempt-codec.ts";
import { RuntimeOperationReducer } from "./runtime-operation-reducer.ts";

const startSchema = z.strictObject({
  sessionId: z.string(), attemptId: z.string(),
  descriptor: bindingDescriptorSchema.optional(),
  inputSnapshot: InputSnapshotSchema.optional(),
  input: InputSnapshotSchema.optional(),
  workAreas: z.array(WorkAreaSchema).default([]),
});
export class RuntimeWorker {
  private readonly connectors: ConnectorRegistry;
  private readonly operations: OperationRepository;
  private readonly state: StateRepository;
  private readonly interactions: InteractionRepository;
  private readonly delivery: RuntimeDeliveryWorker;
  private readonly sessions: RuntimeSessionWorker;
  private readonly reducer: RuntimeOperationReducer;

  constructor(input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly state: StateRepository; readonly execution: ExecutionRepository;
    readonly attempts: AttemptFactory; readonly work: WorkRepository;
    readonly interactions: InteractionRepository;
  }) {
    this.connectors = input.connectors;
    this.operations = input.operations;
    this.state = input.state;
    this.interactions = input.interactions;
    this.delivery = new RuntimeDeliveryWorker(
      input.connectors, input.operations, input.interactions, input.state,
    );
    this.sessions = new RuntimeSessionWorker(
      input.connectors, input.operations, input.state, input.execution, input.attempts, input.work,
    );
    this.reducer = new RuntimeOperationReducer({
      state: input.state, interactions: input.interactions,
      delivery: this.delivery, sessions: this.sessions,
    });
  }

  async start(item: OutboxItem): Promise<void> {
    const payload = startSchema.parse(item.payload);
    if (this.state.stopRequested(item.workspaceId, payload.attemptId)) {
      this.operations.settleConfirmed(item.id, {
        status: "confirmed", effect: "attempt.canceled_before_input",
      }, () => {
        this.state.finishAttempt(item.workspaceId, payload.attemptId, "canceled");
        this.enqueueSessionDetach(item, payload.sessionId);
      });
      return;
    }
    const descriptor = payload.descriptor ?? bindingDescriptorSchema.parse(
      this.state.runtimeBinding(item.workspaceId, payload.sessionId),
    );
    const snapshot = payload.inputSnapshot ?? payload.input;
    if (snapshot === undefined) throw new TypeError("Attempt start is missing its input snapshot.");
    const target = {
      ...runtimeTarget(descriptor, { sessionId: payload.sessionId, generation: 1 }),
      hubAttemptId: payload.attemptId,
    };
    const input: AttemptStart = {
      target, input: runtimeInputSnapshot(snapshot), workAreas: runtimeWorkAreas(payload.workAreas),
    };
    const receipt = await this.connectors.runtime(item.installationId)
      .startAttempt(actionContext(item, [descriptor.controlGrant.id]), input);
    if (receipt.status !== "confirmed") {
      this.settle(item, receipt, () => {}, () => {}, () => {
        this.state.finishAttempt(item.workspaceId, payload.attemptId, "failed");
      });
      return;
    }
    const observation = await this.connectors.runtime(item.installationId).inspectSession(
      callContext(item),
      runtimeTarget(descriptor, { sessionId: payload.sessionId, generation: item.targetGeneration ?? 1 }),
    );
    this.operations.settleConfirmed(item.id, receipt, () => {
      if (receipt.result.nativeExecutionRef !== undefined) {
        this.state.saveAttemptNativeExecution(
          item.workspaceId, payload.attemptId, receipt.result.nativeExecutionRef,
        );
      }
      switch (observation.value.execution.phase) {
        case "running":
          this.state.setAttemptPhase(item.workspaceId, payload.attemptId, "running");
          return;
        case "waiting_input":
          this.state.setAttemptPhase(item.workspaceId, payload.attemptId, "waiting_input");
          return;
        case "idle":
        case "unknown":
        case "ended":
          return;
      }
    });
  }

  async instruct(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({
      sessionId: z.string(), attemptId: z.string(), text: z.string(),
      referenceIds: z.array(z.string()),
      mode: z.union([z.literal("immediate"), z.literal("runtime_queued")]),
    }).parse(item.payload);
    if (!this.state.attemptCanReceiveInput(item.workspaceId, payload.attemptId)) {
      this.operations.markOutbox(item.id, "done", {
        status: "rejected", code: "attempt_ended",
      });
      return;
    }
    const descriptor = bindingDescriptorSchema.parse(
      this.state.runtimeBinding(item.workspaceId, payload.sessionId),
    );
    if (descriptor.controlGrant.mode !== "control" ||
      !descriptor.controlGrant.allowedActions.includes("send_instruction") ||
      (descriptor.controlGrant.expiresAt !== undefined &&
        descriptor.controlGrant.expiresAt <= new Date().toISOString())) {
      this.operations.markOutbox(item.id, "done", { status: "rejected", code: "runtime_control_invalid" });
      return;
    }
    const input: InstructionInput = {
      target: {
        ...runtimeTarget(descriptor, { sessionId: payload.sessionId, generation: item.targetGeneration ?? 1 }),
        hubAttemptId: payload.attemptId,
        ...nativeExecutionTarget(this.state, item.workspaceId, payload.attemptId),
      },
      text: payload.text, referenceIds: payload.referenceIds, mode: payload.mode,
    };
    const receipt = await this.connectors.runtime(item.installationId)
      .sendInstruction(actionContext(item, [descriptor.controlGrant.id]), input);
    this.settle(item, receipt, () => {});
  }

  async stop(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({
      sessionId: z.string(), attemptId: z.string(),
      mode: z.union([
        z.literal("interrupt"), z.literal("stop_work"), z.literal("terminate_session_process"),
      ]),
      reason: z.string().optional(),
    }).parse(item.payload);
    const descriptor = this.state.runtimeBinding(item.workspaceId, payload.sessionId);
    const parsedDescriptor = bindingDescriptorSchema.parse(descriptor);
    if (parsedDescriptor.controlGrant.mode !== "control" ||
      !parsedDescriptor.controlGrant.allowedActions.includes("request_stop") ||
      (parsedDescriptor.controlGrant.expiresAt !== undefined &&
        parsedDescriptor.controlGrant.expiresAt <= new Date().toISOString())) {
      this.operations.markOutbox(item.id, "done", { status: "rejected", code: "runtime_control_invalid" });
      return;
    }
    const input: StopInput = {
      target: {
        ...runtimeTarget(descriptor, { sessionId: payload.sessionId, generation: item.targetGeneration ?? 1 }),
        hubAttemptId: payload.attemptId,
        ...nativeExecutionTarget(this.state, item.workspaceId, payload.attemptId),
      },
      mode: payload.mode,
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    };
    const receipt = await this.connectors.runtime(item.installationId)
      .requestStop(actionContext(item, [parsedDescriptor.controlGrant.id]), input);
    this.settle(item, receipt, (result) => {
      if (result.effect !== "request_accepted") {
        this.state.finishAttempt(item.workspaceId, payload.attemptId, "canceled");
      }
    });
  }

  async deliver(item: OutboxItem): Promise<void> {
    await this.delivery.deliver(item);
  }

  async attachExisting(item: OutboxItem): Promise<void> {
    await this.sessions.attachExisting(item);
  }

  async requestControl(item: OutboxItem): Promise<void> {
    await this.sessions.requestControl(item);
  }

  async detachSession(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({ sessionId: z.string(),
      observedAttemptId: z.string().optional() }).parse(item.payload);
    const descriptor = bindingDescriptorSchema.parse(
      this.state.runtimeBinding(item.workspaceId, payload.sessionId),
    );
    const receipt = await this.connectors.runtime(item.installationId).detachSession(
      actionContext(item, [descriptor.controlGrant.id]),
      runtimeTarget(descriptor, {
        sessionId: payload.sessionId, generation: item.targetGeneration ?? 1,
      }),
    );
    this.settle(item, receipt, () => {
      this.state.closeSession(item.workspaceId, payload.sessionId, payload.observedAttemptId);
    });
  }

  applyLookup(item: OutboxItem, result: unknown): void {
    this.reducer.applyLookup(item, result);
  }

  applyFailure(item: OutboxItem, receipt: object): void {
    this.reducer.applyFailure(item, receipt);
  }

  private settle<T>(
    item: OutboxItem,
    receipt: OperationReceipt<T>,
    confirmed: (result: T) => void,
    uncertain: () => void = () => {},
    failed: () => void = () => {},
  ): void {
    switch (receipt.status) {
      case "confirmed":
        this.operations.settleConfirmed(item.id, receipt, () => confirmed(receipt.result));
        return;
      case "accepted":
      case "running":
      case "unknown":
        uncertain();
        this.operations.markForLookup(item.id, receipt);
        return;
      case "rejected":
      case "failed":
        this.operations.settleTerminal(item.id, receipt.status, receipt, failed);
        return;
    }
  }

  private enqueueSessionDetach(item: OutboxItem, sessionId: string): void {
    const binding = this.state.runtimeBindingRecord(item.workspaceId, sessionId);
    const payload = { sessionId };
    this.operations.addOutbox({
      workspaceId: item.workspaceId, commandId: item.commandId,
      workType: "runtime.detachSession", connectorKind: "runtime",
      installationId: item.installationId, stage: "detach_canceled_session",
      targetId: sessionId, targetGeneration: binding.generation,
      payload, inputDigest: digest(payload),
    });
  }

}
