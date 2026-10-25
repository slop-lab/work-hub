import { z } from "zod";

import {
  EffectEvidenceSchema, EnvironmentAttachmentSchema, LifecycleGrantSchema, NativeRefSchema, ResourceIdentitySchema,
  type AllocationRelease, type OperationReceipt,
} from "../contracts/index.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import { actionContext, callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";

export class ExecutionWorker {
  private readonly connectors: ConnectorRegistry;
  private readonly operations: OperationRepository;
  private readonly environments: EnvironmentRepository;

  constructor(input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly environments: EnvironmentRepository;
  }) {
    this.connectors = input.connectors;
    this.operations = input.operations;
    this.environments = input.environments;
  }

  async verify(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({ registrationId: z.string(), expectedRevision: z.number() })
      .parse(item.payload);
    const registration = this.environments.connectorRegistration(item.workspaceId, payload.registrationId);
    if (registration.revision !== payload.expectedRevision) {
      this.operations.markOutbox(item.id, "done", { status: "rejected", code: "revision_conflict" });
      return;
    }
    const observation = await this.connectors.execution(item.installationId)
      .probeExisting(callContext(item), registration);
    this.environments.saveProbe(item.workspaceId, registration.id, observation.value);
    this.operations.markOutbox(item.id, "done", { status: "confirmed", observation });
  }

  async detach(item: OutboxItem): Promise<void> {
    const bindingId = z.strictObject({ bindingId: z.string() }).parse(item.payload).bindingId;
    const details = this.environments.connectorBinding(item.workspaceId, bindingId);
    if (item.targetGeneration === undefined || details.binding.generation !== item.targetGeneration ||
      details.binding.state !== "detaching") {
      this.operations.markOutbox(item.id, "done", {
        status: "rejected", code: "binding_generation_or_state_changed",
      });
      return;
    }
    const receipt = await this.connectors.execution(item.installationId).detachAttachment(
      actionContext(item, [details.attachment.useGrant.id]),
      { attachmentRef: details.attachment.attachmentRef, expectedIdentity: details.attachment.identity },
    );
    this.settle(item, receipt, () => {
      this.environments.updateBindingState(item.workspaceId, bindingId, "detached");
    });
  }

  async release(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({
      bindingId: z.string(), preservationDecisionRef: z.string(), operatorDecisionRef: z.string().optional(),
      controlledWorkTermination: z.discriminatedUnion("status", [
        z.strictObject({ status: z.literal("confirmed"), evidence: EffectEvidenceSchema }),
        z.strictObject({ status: z.literal("no_controlled_work") }),
      ]),
    }).parse(item.payload);
    const details = this.environments.connectorBinding(item.workspaceId, payload.bindingId);
    if (details.lifecycleGrant === undefined) {
      this.operations.markOutbox(item.id, "done", { status: "rejected", code: "release_not_granted" });
      return;
    }
    if (item.targetGeneration === undefined || details.binding.generation !== item.targetGeneration ||
      details.binding.state !== "releasing" ||
      !details.lifecycleGrant.allowedActions.includes("release_allocation") ||
      (details.lifecycleGrant.expiresAt !== undefined &&
        details.lifecycleGrant.expiresAt <= new Date().toISOString()) ||
      details.lifecycleGrant.releasePolicyRef !== details.attachment.lifecycleGrant?.releasePolicyRef ||
      (payload.preservationDecisionRef !== "preserve_references" &&
        payload.preservationDecisionRef !== "accept_reference_expiry")) {
      this.operations.markOutbox(item.id, "done", {
        status: "rejected", code: "release_authority_changed",
      });
      return;
    }
    const observation = await this.connectors.execution(item.installationId)
      .inspectBinding(callContext(item), details.attachment);
    if (observation.value.identity.native.id !== details.attachment.identity.native.id ||
      observation.value.identity.native.incarnation !== details.attachment.identity.native.incarnation ||
      observation.value.grantValid !== true) {
      this.operations.markOutbox(item.id, "done", {
        status: "rejected", code: "identity_or_grant_changed", observation,
      });
      return;
    }
    const input: AllocationRelease = {
      allocationRef: details.lifecycleGrant.allocationRef,
      expectedIdentity: details.attachment.identity,
      lifecycleGrant: details.lifecycleGrant,
      releasePolicyRef: details.lifecycleGrant.releasePolicyRef,
      controlledWorkTermination: payload.controlledWorkTermination,
      preservationDecisionRef: payload.preservationDecisionRef,
    };
    const receipt = await this.connectors.execution(item.installationId)
      .releaseAllocation(actionContext(item, [details.lifecycleGrant.id]), input);
    this.settle(item, receipt, () => {
      this.environments.updateBindingState(item.workspaceId, payload.bindingId, "released");
    });
  }

  async cancel(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({ attemptId: z.string(), operationIdToCancel: z.string() })
      .parse(item.payload);
    const receipt = await this.connectors.execution(item.installationId).cancelOperation(
      actionContext(item),
      payload.operationIdToCancel,
    );
    this.settle(item, receipt, () => {});
  }

  async releaseCanceled(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({
      attemptId: z.string(), bindingId: z.string(), allocationRef: NativeRefSchema,
      identity: ResourceIdentitySchema, lifecycleGrant: LifecycleGrantSchema,
      releasePolicyRef: z.string(),
    }).parse(item.payload);
    const input: AllocationRelease = {
      allocationRef: payload.allocationRef,
      expectedIdentity: payload.identity,
      lifecycleGrant: payload.lifecycleGrant,
      releasePolicyRef: payload.releasePolicyRef,
      controlledWorkTermination: { status: "no_controlled_work" as const },
      preservationDecisionRef: `automatic-cancel:${payload.attemptId}`,
    };
    const receipt = await this.connectors.execution(item.installationId)
      .releaseAllocation(actionContext(item, [payload.lifecycleGrant.id]), input);
    this.settle(item, receipt, () => {
      this.environments.updateBindingState(item.workspaceId, payload.bindingId, "released");
    });
  }

  async detachCanceled(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({ bindingId: z.string(), attachment: EnvironmentAttachmentSchema })
      .parse(item.payload);
    const receipt = await this.connectors.execution(item.installationId).detachAttachment(
      actionContext(item, [payload.attachment.useGrant.id]),
      { attachmentRef: payload.attachment.attachmentRef, expectedIdentity: payload.attachment.identity },
    );
    this.settle(item, receipt, () => {
      this.environments.updateBindingState(item.workspaceId, payload.bindingId, "detached");
    });
  }

  applyLookup(item: OutboxItem): void {
    switch (item.operationKind) {
      case "execution.detachAttachment": {
        const bindingId = z.strictObject({ bindingId: z.string() }).parse(item.payload).bindingId;
        this.environments.updateBindingState(item.workspaceId, bindingId, "detached");
        return;
      }
      case "execution.releaseAllocation": {
        const bindingId = z.strictObject({ bindingId: z.string() }).passthrough().parse(item.payload).bindingId;
        this.environments.updateBindingState(item.workspaceId, bindingId, "released");
        return;
      }
      default:
        throw new TypeError(`Unsupported execution lookup stage ${item.operationKind}.`);
    }
  }

  private settle<T>(item: OutboxItem, receipt: OperationReceipt<T>, confirmed: () => void): void {
    switch (receipt.status) {
      case "confirmed":
        this.operations.settleConfirmed(item.id, receipt, confirmed);
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
    }
  }
}
