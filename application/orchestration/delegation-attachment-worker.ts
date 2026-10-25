import { z } from "zod";

import {
  EnvironmentAttachmentSchema, ExistingEnvironmentRegistrationSchema, LifecycleGrantSchema,
  NativeRefSchema, ResourceIdentitySchema, type AttachmentRequest, type EnvironmentAttachment,
  type OperationReceipt,
} from "../contracts/index.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import { digest } from "../persistence/codec.ts";
import { actionContext, callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { attachmentHonorsSelection } from "./environment-safety.ts";
import { delegationSchema, delegationWorkAreas } from "./delegation-schema.ts";

export class DelegationAttachmentWorker {
  private readonly input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly environments: EnvironmentRepository; readonly execution: ExecutionRepository;
    readonly state: StateRepository;
  };

  constructor(input: DelegationAttachmentWorker["input"]) { this.input = input; }

  async attach(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({ delegation: delegationSchema,
      target: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("registered_existing"),
          registration: ExistingEnvironmentRegistrationSchema, expectedIdentity: ResourceIdentitySchema }),
        z.strictObject({ kind: z.literal("allocation"), allocationRef: NativeRefSchema,
          expectedIdentity: ResourceIdentitySchema, lifecycleGrant: LifecycleGrantSchema }),
      ]), authorizedGrantRefs: z.array(z.string()) }).parse(item.payload);
    const delegation = payload.delegation;
    if (this.input.state.stopRequested(item.workspaceId, delegation.attemptId)) {
      this.input.state.finishAttempt(item.workspaceId, delegation.attemptId, "canceled");
      this.input.operations.markOutbox(item.id, "done", {
        status: "confirmed", effect: "attempt.canceled_before_attach",
      });
      return;
    }
    if (delegation.bindingId === undefined || delegation.environment.mode === "none") {
      throw new TypeError("Environment attachment job is missing a binding.");
    }
    const bindingId = delegation.bindingId;
    const attempt = this.input.execution.getAttempt(item.workspaceId, delegation.attemptId);
    const session = this.input.execution.getSession(item.workspaceId, delegation.sessionId);
    const attachmentInput: AttachmentRequest = { hubBindingId: delegation.bindingId,
      hubBindingGeneration: 1, projectId: session.projectId, taskId: attempt.taskId,
      sessionId: session.id, attemptId: attempt.id, target: payload.target,
      workAreas: delegationWorkAreas(delegation.environment.workAreas),
      requestedAccess: delegation.environment.mode === "existing"
        ? delegation.environment.requestedAccess
        : delegation.environment.workAreas.some((area) => area.requestedAccess === "write")
          ? "write" : "read", preparation: "preserve_existing" };
    const receipt = await this.input.connectors.execution(item.installationId)
      .attach(actionContext(item, payload.authorizedGrantRefs), attachmentInput);
    if (receipt.status === "confirmed" && !attachmentHonorsSelection({
      attachment: receipt.result, expectedIdentity: payload.target.expectedIdentity,
      requestedAccess: attachmentInput.requestedAccess, workAreas: attachmentInput.workAreas,
      now: new Date().toISOString(),
    })) {
      this.rejectConfirmedDelegation(
        item, delegation.attemptId, delegation.sessionId, bindingId,
        receipt.result, "attachment_grant_mismatch",
      );
      return;
    }
    if (receipt.status === "confirmed" && attachmentInput.requestedAccess === "write") {
      const observation = await this.input.connectors.execution(item.installationId)
        .inspectBinding(callContext(item), receipt.result);
      if (observation.value.knownExternalActivity !== "idle") {
        this.rejectConfirmedDelegation(
          item, delegation.attemptId, delegation.sessionId, bindingId,
          receipt.result, "known_external_activity", observation,
        );
        return;
      }
    }
    this.settle(item, receipt, (attachment) => {
      const compatible = this.input.state.saveEnvironmentAttachment({ workspaceId: item.workspaceId,
        bindingId, attachment, identity: attachment.identity,
        useGrant: attachment.useGrant,
        ...(attachment.lifecycleGrant === undefined ? {} : {
          lifecycleGrant: attachment.lifecycleGrant,
        }) });
      if (!compatible) {
        this.enqueueAttachmentCleanup(item, bindingId, attachment, "detach_conflicting_attachment");
        this.input.state.finishAttempt(item.workspaceId, delegation.attemptId, "failed");
        this.input.state.closeSession(item.workspaceId, delegation.sessionId);
        return;
      }
      if (this.input.state.stopRequested(item.workspaceId, delegation.attemptId)) {
        const cleanup = { bindingId, attachment };
        this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
          workType: "execution.detachCanceledAttachment", connectorKind: "execution",
          installationId: item.installationId, stage: "detach_canceled_attachment",
          targetId: bindingId, targetGeneration: 1,
          payload: cleanup, inputDigest: digest(cleanup) });
        this.input.state.finishAttempt(item.workspaceId, delegation.attemptId, "canceled");
        return;
      }
      const profile = this.input.execution.getProfile(
        item.workspaceId, delegation.profileId, delegation.profileRevision,
      );
      const route = attachment.routes[0];
      if (route === undefined) throw new TypeError("Attachment returned no runtime route.");
      const next = { delegation, attachment, route };
      this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
        workType: "runtime.openForDelegation", connectorKind: "runtime",
        installationId: profile.runtimeInstallationId, stage: "open_session",
        targetId: delegation.sessionId, targetGeneration: 1,
        payload: next, inputDigest: digest(next) });
    }, () => this.failDelegation(
      item, delegation.attemptId, delegation.sessionId, bindingId,
    ));
  }

  applyLookup(item: OutboxItem, result: unknown): void {
    const payload = z.strictObject({ delegation: delegationSchema,
      target: z.record(z.string(), z.unknown()), authorizedGrantRefs: z.array(z.string()) })
      .parse(item.payload);
    const attachment = EnvironmentAttachmentSchema.parse(result);
    const bindingId = payload.delegation.bindingId;
    if (bindingId === undefined) throw new TypeError("Attachment binding is missing.");
    if (payload.delegation.environment.mode === "none") {
      throw new TypeError("Environment attachment lookup has no environment selection.");
    }
    const compatible = this.input.state.saveEnvironmentAttachment({ workspaceId: item.workspaceId, bindingId,
      attachment, identity: attachment.identity, useGrant: attachment.useGrant,
      ...(attachment.lifecycleGrant === undefined ? {} : {
        lifecycleGrant: attachment.lifecycleGrant,
      }) });
    if (!compatible || !attachmentHonorsSelection({ attachment,
      expectedIdentity: z.strictObject({ expectedIdentity: ResourceIdentitySchema })
        .passthrough().parse(payload.target).expectedIdentity,
      requestedAccess: payload.delegation.environment.mode === "existing"
        ? payload.delegation.environment.requestedAccess
        : payload.delegation.environment.workAreas.some((area) => area.requestedAccess === "write")
          ? "write" : "read",
      workAreas: delegationWorkAreas(payload.delegation.environment.workAreas),
      now: new Date().toISOString(),
    })) {
      this.enqueueAttachmentCleanup(item, bindingId, attachment, "detach_rejected_lookup_attachment");
      this.input.state.finishAttempt(item.workspaceId, payload.delegation.attemptId, "failed");
      this.input.state.closeSession(item.workspaceId, payload.delegation.sessionId);
      return;
    }
    const profile = this.input.execution.getProfile(
      item.workspaceId, payload.delegation.profileId, payload.delegation.profileRevision,
    );
    const route = attachment.routes[0];
    if (route === undefined) throw new TypeError("Attachment returned no runtime route.");
    const next = { delegation: payload.delegation, attachment, route };
    this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
      workType: "runtime.openForDelegation", connectorKind: "runtime",
      installationId: profile.runtimeInstallationId, stage: "open_session",
      targetId: payload.delegation.sessionId, targetGeneration: 1,
      payload: next, inputDigest: digest(next) });
  }

  applyFailure(item: OutboxItem): void {
    const payload = z.strictObject({ delegation: delegationSchema }).passthrough().parse(item.payload);
    const bindingId = payload.delegation.bindingId;
    if (bindingId === undefined) throw new TypeError("Attachment failure is missing its binding ID.");
    this.failDelegation(item, payload.delegation.attemptId,
      payload.delegation.sessionId, bindingId);
  }

  private rejectConfirmedDelegation(
    item: OutboxItem, attemptId: string, sessionId: string, bindingId: string,
    attachment: EnvironmentAttachment, code: string,
    observation?: object,
  ): void {
    this.persistRejectedAttachment(item, bindingId, attachment, "detach_rejected_attachment");
    this.input.operations.markOutbox(item.id, "done", {
      status: "rejected", code, ...(observation === undefined ? {} : { observation }),
    });
    this.input.state.finishAttempt(item.workspaceId, attemptId, "failed");
    this.input.state.closeSession(item.workspaceId, sessionId);
  }

  private persistRejectedAttachment(
    item: OutboxItem, bindingId: string,
    attachment: EnvironmentAttachment, stage: string,
  ): void {
    this.input.state.saveEnvironmentAttachment({ workspaceId: item.workspaceId, bindingId,
      attachment, identity: attachment.identity, useGrant: attachment.useGrant,
      ...(attachment.lifecycleGrant === undefined ? {} : { lifecycleGrant: attachment.lifecycleGrant }) });
    this.enqueueAttachmentCleanup(item, bindingId, attachment, stage);
  }

  private enqueueAttachmentCleanup(
    item: OutboxItem, bindingId: string,
    attachment: EnvironmentAttachment, stage: string,
  ): void {
    const cleanup = { bindingId, attachment };
    this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
      workType: "execution.detachCanceledAttachment", connectorKind: "execution",
      installationId: attachment.attachmentRef.installationId, stage,
      targetId: bindingId, targetGeneration: attachment.hubBindingGeneration,
      payload: cleanup, inputDigest: digest(cleanup) });
  }

  private failDelegation(
    item: OutboxItem, attemptId: string, sessionId: string, bindingId: string,
  ): void {
    this.input.environments.updateBindingState(item.workspaceId, bindingId, "failed");
    this.input.state.finishAttempt(item.workspaceId, attemptId, "failed");
    this.input.state.closeSession(item.workspaceId, sessionId);
  }

  private settle<T>(
    item: OutboxItem,
    receipt: OperationReceipt<T>,
    confirmed: (result: T) => void,
    failed: () => void,
  ): void {
    switch (receipt.status) {
      case "confirmed": this.input.operations.settleConfirmed(item.id, receipt,
        () => confirmed(receipt.result)); return;
      case "accepted":
      case "running":
      case "unknown": this.input.operations.markForLookup(item.id, receipt); return;
      case "rejected":
      case "failed": this.input.operations.settleTerminal(item.id, receipt.status, receipt, failed); return;
    }
  }
}
