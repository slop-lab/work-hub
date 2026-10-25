import { z } from "zod";

import {
  EnvironmentAttachmentSchema, ExistingEnvironmentRegistrationSchema, LifecycleGrantSchema,
  NativeRefSchema, ResourceIdentitySchema, type AttachmentRequest, type OperationReceipt,
  WorkAreaSchema,
} from "../contracts/index.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import { digest } from "../persistence/codec.ts";
import { actionContext, callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { attachmentHonorsSelection, sameResourceIdentity, verifiedExistingTarget } from "./environment-safety.ts";
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
      this.reject(item, delegation.attemptId, "attachment_grant_mismatch"); return;
    }
    if (receipt.status === "confirmed" && attachmentInput.requestedAccess === "write") {
      const observation = await this.input.connectors.execution(item.installationId)
        .inspectBinding(callContext(item), receipt.result);
      if (observation.value.knownExternalActivity !== "idle") {
        this.input.operations.markOutbox(item.id, "done", {
          status: "rejected", code: "known_external_activity", observation,
        });
        this.input.state.finishAttempt(item.workspaceId, delegation.attemptId, "failed");
        return;
      }
    }
    this.settle(item, receipt, (attachment) => {
      this.input.state.saveEnvironmentAttachment({ workspaceId: item.workspaceId,
        bindingId, attachment, identity: attachment.identity,
        useGrant: attachment.useGrant,
        ...(attachment.lifecycleGrant === undefined ? {} : {
          lifecycleGrant: attachment.lifecycleGrant,
        }) });
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
    });
  }

  async attachSessionEnvironment(item: OutboxItem): Promise<void> {
    const payload = z.strictObject({ sessionId: z.string(), taskId: z.string(),
      profileId: z.string(), profileRevision: z.number(), nativeSession: NativeRefSchema,
      controlMode: z.union([z.literal("observe"), z.literal("control")]),
      environment: z.strictObject({ mode: z.literal("existing"), registrationId: z.string(),
        expectedRegistrationRevision: z.number(), workAreas: z.array(WorkAreaSchema),
        requestedAccess: z.union([z.literal("read"), z.literal("write")]) }),
      bindingId: z.string() }).parse(item.payload);
    const registration = this.input.environments.connectorRegistration(
      item.workspaceId, payload.environment.registrationId,
    );
    const observation = await this.input.connectors.execution(item.installationId)
      .probeExisting(callContext(item), registration);
    const priorIdentity = registration.verifiedIdentity;
    if (priorIdentity !== undefined && !sameResourceIdentity(priorIdentity, observation.value.identity)) {
      this.input.operations.markOutbox(item.id, "done", {
        status: "failed", code: "identity_mismatch", observation,
      });
      return;
    }
    if (priorIdentity === undefined || !verifiedExistingTarget({ registration, priorIdentity,
      probe: observation.value, selection: payload.environment, now: new Date().toISOString() })) {
      this.input.operations.markOutbox(item.id, "done", {
        status: "rejected", code: "requirements_not_met", observation,
      });
      return;
    }
    const workAreas = delegationWorkAreas(registration.allowedWorkAreas.filter((area) =>
      payload.environment.workAreas.some((requested) => requested.key === area.key)));
    const attachmentInput: AttachmentRequest = { hubBindingId: payload.bindingId,
      hubBindingGeneration: 1,
      projectId: this.input.execution.getSession(item.workspaceId, payload.sessionId).projectId,
      taskId: payload.taskId, sessionId: payload.sessionId,
      target: { kind: "registered_existing", registration, expectedIdentity: observation.value.identity },
      workAreas, requestedAccess: payload.environment.requestedAccess,
      preparation: "preserve_existing" };
    const receipt = await this.input.connectors.execution(item.installationId)
      .attach(actionContext(item, [observation.value.availableUseGrant.id]), attachmentInput);
    if (receipt.status !== "confirmed") { this.settle(item, receipt, () => {}); return; }
    const attachment = receipt.result;
    if (!attachmentHonorsSelection({ attachment, expectedIdentity: observation.value.identity,
      requestedAccess: attachmentInput.requestedAccess, workAreas: attachmentInput.workAreas,
      now: new Date().toISOString() })) {
      this.input.operations.markOutbox(item.id, "done", {
        status: "rejected", code: "attachment_grant_mismatch",
      });
      return;
    }
    const bindingObservation = await this.input.connectors.execution(item.installationId)
      .inspectBinding(callContext(item), attachment);
    if (attachmentInput.requestedAccess === "write" &&
      bindingObservation.value.knownExternalActivity !== "idle") {
      this.input.operations.markOutbox(item.id, "done", {
        status: "rejected", code: "known_external_activity", observation: bindingObservation,
      });
      return;
    }
    const route = attachment.routes[0];
    if (route === undefined) throw new TypeError("Attachment returned no runtime route.");
    const profile = this.input.execution.getProfile(
      item.workspaceId, payload.profileId, payload.profileRevision,
    );
    const next = { ...payload, attachment, route };
    this.input.operations.settleConfirmed(item.id, receipt, () => {
      this.input.state.saveEnvironmentAttachment({ workspaceId: item.workspaceId,
        bindingId: payload.bindingId, attachment, identity: attachment.identity,
        useGrant: attachment.useGrant,
        ...(attachment.lifecycleGrant === undefined ? {} : {
          lifecycleGrant: attachment.lifecycleGrant,
        }) });
      this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
        workType: "session.attachExisting", connectorKind: "runtime",
        installationId: profile.runtimeInstallationId, stage: "open_attached_session",
        targetId: payload.sessionId, targetGeneration: 1,
        payload: next, inputDigest: digest(next) });
    });
  }

  applyLookup(item: OutboxItem, result: unknown): void {
    const payload = z.strictObject({ delegation: delegationSchema,
      target: z.record(z.string(), z.unknown()), authorizedGrantRefs: z.array(z.string()) })
      .parse(item.payload);
    const attachment = EnvironmentAttachmentSchema.parse(result);
    const bindingId = payload.delegation.bindingId;
    if (bindingId === undefined) throw new TypeError("Attachment binding is missing.");
    this.input.state.saveEnvironmentAttachment({ workspaceId: item.workspaceId, bindingId,
      attachment, identity: attachment.identity, useGrant: attachment.useGrant,
      ...(attachment.lifecycleGrant === undefined ? {} : {
        lifecycleGrant: attachment.lifecycleGrant,
      }) });
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

  private reject(item: OutboxItem, attemptId: string, code: string): void {
    this.input.operations.markOutbox(item.id, "done", { status: "rejected", code });
    this.input.state.finishAttempt(item.workspaceId, attemptId, "failed");
  }

  private settle<T>(item: OutboxItem, receipt: OperationReceipt<T>, confirmed: (result: T) => void): void {
    switch (receipt.status) {
      case "confirmed": this.input.operations.settleConfirmed(item.id, receipt,
        () => confirmed(receipt.result)); return;
      case "accepted":
      case "running":
      case "unknown": this.input.operations.markForLookup(item.id, receipt); return;
      case "rejected":
      case "failed": this.input.operations.markOutbox(item.id, "done", receipt); return;
    }
  }
}
