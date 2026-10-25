import { z } from "zod";

import {
  EnvironmentAttachmentSchema, NativeRefSchema, ResourceIdentitySchema,
  type AttachmentRequest, type EnvironmentAttachment, type OperationReceipt, WorkAreaSchema,
} from "../contracts/index.ts";
import { digest } from "../persistence/codec.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import { actionContext, callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { delegationWorkAreas } from "./delegation-schema.ts";
import { attachmentHonorsSelection, sameResourceIdentity, verifiedExistingTarget } from "./environment-safety.ts";

const payloadSchema = z.strictObject({ sessionId: z.string(), taskId: z.string(),
  profileId: z.string(), profileRevision: z.number(), nativeSession: NativeRefSchema,
  controlMode: z.union([z.literal("observe"), z.literal("control")]),
  environment: z.strictObject({ mode: z.literal("existing"), registrationId: z.string(),
    expectedRegistrationRevision: z.number(), workAreas: z.array(WorkAreaSchema),
    requestedAccess: z.union([z.literal("read"), z.literal("write")]) }),
  bindingId: z.string(), expectedIdentity: ResourceIdentitySchema.optional(),
  selectedUseGrantId: z.string().optional() });
const lookupPayloadSchema = payloadSchema.extend({
  expectedIdentity: ResourceIdentitySchema,
  selectedUseGrantId: z.string(),
}).strict();

export class SessionEnvironmentAttachmentWorker {
  private readonly input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly environments: EnvironmentRepository; readonly execution: ExecutionRepository;
    readonly state: StateRepository;
  };

  constructor(input: SessionEnvironmentAttachmentWorker["input"]) { this.input = input; }

  async attach(item: OutboxItem): Promise<void> {
    const payload = payloadSchema.parse(item.payload);
    const registration = this.input.environments.connectorRegistration(
      item.workspaceId, payload.environment.registrationId,
    );
    let observation;
    try {
      observation = await this.input.connectors.execution(item.installationId)
        .probeExisting(callContext(item), registration);
    } catch (error) {
      if (error instanceof Error) {
        this.input.operations.markOutbox(item.id, "pending");
        return;
      }
      throw error;
    }
    const priorIdentity = registration.verifiedIdentity;
    if (priorIdentity !== undefined && !sameResourceIdentity(priorIdentity, observation.value.identity)) {
      this.input.operations.markOutbox(item.id, "done", {
        status: "failed", code: "identity_mismatch", observation,
      });
      this.fail(item, payload.sessionId, payload.bindingId);
      return;
    }
    if (priorIdentity === undefined || !verifiedExistingTarget({ registration, priorIdentity,
      probe: observation.value, selection: payload.environment, now: new Date().toISOString() })) {
      this.input.operations.markOutbox(item.id, "done", {
        status: "rejected", code: "requirements_not_met", observation,
      });
      this.fail(item, payload.sessionId, payload.bindingId);
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
    this.input.operations.recordExpectedAttachment(item.id, {
      expectedIdentity: observation.value.identity,
      selectedUseGrantId: observation.value.availableUseGrant.id,
    });
    const receipt = await this.input.connectors.execution(item.installationId)
      .attach(actionContext(item, [observation.value.availableUseGrant.id]), attachmentInput);
    if (receipt.status !== "confirmed") {
      this.settle(item, receipt, () => {}, () => this.fail(
        item, payload.sessionId, payload.bindingId,
      ));
      return;
    }
    const attachment = receipt.result;
    if (!attachmentHonorsSelection({ attachment, expectedIdentity: observation.value.identity,
      requestedAccess: attachmentInput.requestedAccess, workAreas: attachmentInput.workAreas,
      now: new Date().toISOString() })) {
      this.rejectConfirmed(item, payload, attachment, "attachment_grant_mismatch");
      return;
    }
    const bindingObservation = await this.input.connectors.execution(item.installationId)
      .inspectBinding(callContext(item), attachment);
    if (attachmentInput.requestedAccess === "write" &&
      bindingObservation.value.knownExternalActivity !== "idle") {
      this.rejectConfirmed(item, payload, attachment, "known_external_activity", bindingObservation);
      return;
    }
    const route = attachment.routes[0];
    if (route === undefined) {
      this.rejectConfirmed(item, payload, attachment, "attachment_route_missing");
      return;
    }
    const profile = this.input.execution.getProfile(
      item.workspaceId, payload.profileId, payload.profileRevision,
    );
    const next = this.runtimePayload(payload, attachment, route);
    this.input.operations.settleConfirmed(item.id, receipt, () => {
      const compatible = this.persist(item, payload.bindingId, attachment);
      if (!compatible) {
        this.enqueueCleanup(item, payload.bindingId, attachment,
          "detach_conflicting_session_attachment");
        this.input.state.closeSession(item.workspaceId, payload.sessionId);
        return;
      }
      this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
        workType: "session.attachExisting", connectorKind: "runtime",
        installationId: profile.runtimeInstallationId, stage: "open_attached_session",
        targetId: payload.sessionId, targetGeneration: 1,
        payload: next, inputDigest: digest(next) });
    });
  }

  applyLookup(item: OutboxItem, result: unknown): void {
    const payload = lookupPayloadSchema.parse(item.payload);
    const registration = this.input.environments.connectorRegistration(
      item.workspaceId, payload.environment.registrationId,
    );
    const attachment = EnvironmentAttachmentSchema.parse(result);
    const workAreas = delegationWorkAreas(registration.allowedWorkAreas.filter((area) =>
      payload.environment.workAreas.some((requested) => requested.key === area.key)));
    const compatible = this.persist(item, payload.bindingId, attachment);
    if (!compatible || !attachmentHonorsSelection({
      attachment, expectedIdentity: payload.expectedIdentity,
      requestedAccess: payload.environment.requestedAccess,
      workAreas, now: new Date().toISOString(),
    })) {
      this.enqueueCleanup(item, payload.bindingId, attachment,
        "detach_rejected_session_lookup_attachment");
      this.input.state.closeSession(item.workspaceId, payload.sessionId);
      return;
    }
    const route = attachment.routes[0];
    if (route === undefined) {
      this.enqueueCleanup(item, payload.bindingId, attachment,
        "detach_routeless_session_lookup_attachment");
      this.input.state.closeSession(item.workspaceId, payload.sessionId);
      return;
    }
    const profile = this.input.execution.getProfile(
      item.workspaceId, payload.profileId, payload.profileRevision,
    );
    const next = this.runtimePayload(payload, attachment, route);
    this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
      workType: "session.attachExisting", connectorKind: "runtime",
      installationId: profile.runtimeInstallationId, stage: "open_attached_session",
      targetId: payload.sessionId, targetGeneration: 1,
      payload: next, inputDigest: digest(next) });
  }

  applyFailure(item: OutboxItem): void {
    const payload = payloadSchema.parse(item.payload);
    this.fail(item, payload.sessionId, payload.bindingId);
  }

  private rejectConfirmed(
    item: OutboxItem, payload: z.infer<typeof payloadSchema>, attachment: EnvironmentAttachment,
    code: string, observation?: object,
  ): void {
    this.persist(item, payload.bindingId, attachment);
    this.enqueueCleanup(item, payload.bindingId, attachment, "detach_rejected_session_attachment");
    this.input.operations.markOutbox(item.id, "done", {
      status: "rejected", code, ...(observation === undefined ? {} : { observation }),
    });
    this.input.state.closeSession(item.workspaceId, payload.sessionId);
  }

  private persist(item: OutboxItem, bindingId: string, attachment: EnvironmentAttachment): boolean {
    return this.input.state.saveEnvironmentAttachment({ workspaceId: item.workspaceId, bindingId,
      attachment, identity: attachment.identity, useGrant: attachment.useGrant,
      ...(attachment.lifecycleGrant === undefined ? {} : { lifecycleGrant: attachment.lifecycleGrant }) });
  }

  private enqueueCleanup(
    item: OutboxItem, bindingId: string, attachment: EnvironmentAttachment, stage: string,
  ): void {
    const cleanup = { bindingId, attachment };
    this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
      workType: "execution.detachCanceledAttachment", connectorKind: "execution",
      installationId: attachment.attachmentRef.installationId, stage,
      targetId: bindingId, targetGeneration: attachment.hubBindingGeneration,
      payload: cleanup, inputDigest: digest(cleanup) });
  }

  private fail(item: OutboxItem, sessionId: string, bindingId: string): void {
    this.input.environments.updateBindingState(item.workspaceId, bindingId, "failed");
    this.input.state.closeSession(item.workspaceId, sessionId);
  }

  private runtimePayload(
    payload: z.infer<typeof payloadSchema>, attachment: EnvironmentAttachment,
    route: EnvironmentAttachment["routes"][number],
  ): object {
    return { sessionId: payload.sessionId, taskId: payload.taskId,
      profileId: payload.profileId, profileRevision: payload.profileRevision,
      nativeSession: payload.nativeSession, controlMode: payload.controlMode,
      environment: payload.environment, attachment, route };
  }

  private settle<T>(
    item: OutboxItem, receipt: OperationReceipt<T>, confirmed: (result: T) => void,
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
