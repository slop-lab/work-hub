import { z } from "zod";

import {
  EnvironmentAttachmentSchema,
  OpenSessionInputSchema,
  type OperationReceipt,
  type RuntimeControlGrant,
} from "../contracts/index.ts";
import type { AttemptFactory } from "../persistence/attempt-factory.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import { actionContext, callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { bindingDescriptorSchema, nativeRefSchema, routeSchema, runtimeTarget } from "./runtime-codec.ts";

export class RuntimeSessionWorker {
  private readonly connectors: ConnectorRegistry;
  private readonly operations: OperationRepository;
  private readonly state: StateRepository;
  private readonly execution: ExecutionRepository;
  private readonly attempts: AttemptFactory;
  private readonly work: WorkRepository;

  constructor(
    connectors: ConnectorRegistry,
    operations: OperationRepository,
    state: StateRepository,
    execution: ExecutionRepository,
    attempts: AttemptFactory,
    work: WorkRepository,
  ) {
    this.connectors = connectors;
    this.operations = operations;
    this.state = state;
    this.execution = execution;
    this.attempts = attempts;
    this.work = work;
  }

  async attachExisting(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({
      sessionId: z.string(), taskId: z.string(), profileId: z.string(), profileRevision: z.number(),
      nativeSession: nativeRefSchema,
      controlMode: z.union([z.literal("observe"), z.literal("control")]),
      environment: z.record(z.string(), z.unknown()),
      attachment: EnvironmentAttachmentSchema.optional(), route: routeSchema.optional(),
    }).parse(item.payload);
    const profile = this.execution.getProfile(item.workspaceId, payload.profileId, payload.profileRevision);
    const input = OpenSessionInputSchema.parse({
      hubSessionId: payload.sessionId,
      route: payload.attachment === undefined || payload.route === undefined
        ? { kind: "external", route: { id: `external:${payload.sessionId}`,
            ownerInstallationId: item.installationId, kind: "simulated_external" } }
        : { kind: "environment", attachment: payload.attachment, route: payload.route },
      configuration: profile.configuration, requestedControl: payload.controlMode,
      mode: "attach", nativeSession: payload.nativeSession, sessionLaunchOwner: "external",
    });
    const receipt = await this.connectors.runtime(item.installationId).openSession(
      actionContext(item, payload.attachment === undefined ? [] : [payload.attachment.useGrant.id]),
      input,
    );
    if (receipt.status !== "confirmed") {
      this.settle(item, receipt, () => {}, () => {
        this.state.closeSession(item.workspaceId, payload.sessionId);
      });
      return;
    }
    const descriptor = bindingDescriptorSchema.parse(receipt.result);
    this.operations.settleConfirmed(item.id, receipt, () => {
      this.state.bindRuntime({ workspaceId: item.workspaceId, sessionId: payload.sessionId,
        nativeIdentityKey: JSON.stringify(descriptor.nativeSession), capabilities: descriptor.capabilities,
        descriptor, generation: 1 });
    });
    const observation = await this.connectors.runtime(item.installationId).inspectSession(
      callContext(item), runtimeTarget(descriptor, { sessionId: payload.sessionId, generation: 1 }),
    );
    if (observation.value.execution.phase === "running" ||
      observation.value.execution.phase === "waiting_input") {
      const task = this.work.getTask(item.workspaceId, payload.taskId);
      const session = this.execution.getSession(item.workspaceId, payload.sessionId);
      const attemptId = this.attempts.createObservedAttempt({ workspaceId: item.workspaceId, task, session, profile });
      if (observation.value.execution.nativeExecutionRef !== undefined) {
        this.state.saveAttemptNativeExecution(
          item.workspaceId, attemptId, observation.value.execution.nativeExecutionRef,
        );
      }
      this.state.setAttemptPhase(item.workspaceId, attemptId,
        observation.value.execution.phase === "running" ? "running" : "waiting_input");
    }
  }

  async requestControl(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({
      sessionId: z.string(), requestedActions: z.array(z.union([
        z.literal("start_attempt"), z.literal("send_instruction"), z.literal("deliver_response"),
        z.literal("request_stop"), z.literal("interactive_input"),
      ])),
    }).parse(item.payload);
    const descriptor = bindingDescriptorSchema.parse(this.state.runtimeBinding(item.workspaceId, payload.sessionId));
    const receipt = await this.connectors.runtime(item.installationId).requestControl(
      actionContext(item, [descriptor.controlGrant.id]),
      { target: runtimeTarget(descriptor, { sessionId: payload.sessionId,
          generation: item.targetGeneration ?? 1 }), requestedActions: payload.requestedActions },
    );
    this.settle(item, receipt, (grant) => {
      this.state.updateControlGrant(item.workspaceId, payload.sessionId, {
        ...descriptor, controlGrant: this.scopedGrant(grant, payload.requestedActions),
      });
    });
  }

  applyLookup(item: OutboxItem, result: unknown): void {
    switch (item.operationKind) {
      case "runtime.deliverResponse": {
        return;
      }
      case "session.attachExisting": {
        const payload = z.strictObject({ sessionId: z.string() }).passthrough().parse(item.payload);
        const descriptor = bindingDescriptorSchema.parse(result);
        this.state.bindRuntime({ workspaceId: item.workspaceId, sessionId: payload.sessionId,
          nativeIdentityKey: JSON.stringify(descriptor.nativeSession), capabilities: descriptor.capabilities,
          descriptor, generation: 1 });
        return;
      }
      case "runtime.requestControl": {
        const payload = z.strictObject({ sessionId: z.string(), requestedActions: z.array(z.union([
          z.literal("start_attempt"), z.literal("send_instruction"), z.literal("deliver_response"),
          z.literal("request_stop"), z.literal("interactive_input"),
        ])) }).passthrough().parse(item.payload);
        const descriptor = bindingDescriptorSchema.parse(this.state.runtimeBinding(item.workspaceId, payload.sessionId));
        const grant = z.strictObject({
          id: z.string(), mode: z.literal("control"),
          allowedActions: z.array(z.union([
            z.literal("start_attempt"), z.literal("send_instruction"), z.literal("deliver_response"),
            z.literal("request_stop"), z.literal("interactive_input"),
          ])),
          expiresAt: z.string().optional(), externalClientsMayAlsoControl: z.boolean(),
        }).parse(result);
        this.state.updateControlGrant(item.workspaceId, payload.sessionId, {
          ...descriptor, controlGrant: this.scopedGrant(grant, payload.requestedActions),
        });
        return;
      }
      default: throw new TypeError(`Unsupported runtime session lookup stage ${item.operationKind}.`);
    }
  }

  private scopedGrant(
    grant: RuntimeControlGrant,
    requestedActions: readonly RuntimeControlGrant["allowedActions"][number][],
  ): RuntimeControlGrant {
    return {
      ...grant,
      allowedActions: grant.allowedActions.filter((action) => requestedActions.includes(action)),
    };
  }

  private settle<T>(
    item: OutboxItem, receipt: OperationReceipt<T>, confirmed: (result: T) => void,
    failed: () => void = () => {},
  ): void {
    switch (receipt.status) {
      case "confirmed": this.operations.settleConfirmed(item.id, receipt, () => confirmed(receipt.result)); return;
      case "accepted":
      case "running":
      case "unknown": this.operations.markForLookup(item.id, receipt); return;
      case "rejected":
      case "failed": this.operations.settleTerminal(item.id, receipt.status, receipt, failed); return;
    }
  }
}
