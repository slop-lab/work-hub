import { z } from "zod";

import {
  AllocationRequestSchema, LifecycleGrantSchema, NativeRefSchema, ResourceIdentitySchema,
  OpenSessionInputSchema, type OperationReceipt,
} from "../contracts/index.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { OperationRepository, OutboxItem } from "../persistence/operation-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import { digest } from "../persistence/codec.ts";
import { actionContext, callContext } from "./context.ts";
import type { ConnectorRegistry } from "./connectors.ts";
import { sameResourceIdentity, verifiedExistingTarget } from "./environment-safety.ts";
import { delegationSchema, type DelegationPayload } from "./delegation-schema.ts";

export class DelegationPreparationWorker {
  private readonly input: {
    readonly connectors: ConnectorRegistry; readonly operations: OperationRepository;
    readonly environments: EnvironmentRepository; readonly execution: ExecutionRepository;
    readonly state: StateRepository;
    readonly bindAndStart: (item: OutboxItem, delegation: DelegationPayload, result: unknown) => void;
  };

  constructor(input: DelegationPreparationWorker["input"]) { this.input = input; }

  async advance(item: OutboxItem): Promise<void> {
    const payload = delegationSchema.parse(item.payload);
    if (this.input.state.stopRequested(item.workspaceId, payload.attemptId)) {
      const receipt = { status: "confirmed", effect: "attempt.canceled_before_start" };
      this.input.operations.settleConfirmed(item.id, receipt, () => {
        this.input.state.finishAttempt(item.workspaceId, payload.attemptId, "canceled");
      });
      return;
    }
    switch (payload.environment.mode) {
      case "existing": {
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
        if (priorIdentity !== undefined &&
          !sameResourceIdentity(priorIdentity, observation.value.identity)) {
          const receipt = { status: "failed", code: "identity_mismatch", observation };
          this.input.operations.settleTerminal(item.id, "failed", receipt,
            () => this.failDelegation(item, payload));
          return;
        }
        if (priorIdentity === undefined || !verifiedExistingTarget({
          registration, priorIdentity, probe: observation.value,
          selection: payload.environment, now: new Date().toISOString(),
        })) {
          const receipt = { status: "rejected", code: "requirements_not_met", observation };
          this.input.operations.settleTerminal(item.id, "rejected", receipt,
            () => this.failDelegation(item, payload));
          return;
        }
        const receipt = { status: "confirmed", observation };
        this.input.operations.settleConfirmed(item.id, receipt, () => {
          const verified = this.input.environments.saveProbe(
            item.workspaceId, registration.id, observation.value,
          );
          this.enqueueAttachment(item, payload, {
            kind: "registered_existing",
            registration: this.input.environments.connectorRegistration(item.workspaceId, verified.id),
            expectedIdentity: observation.value.identity,
          }, [observation.value.availableUseGrant.id]);
        });
        return;
      }
      case "provision": {
        const request = AllocationRequestSchema.parse({ taskId: payload.taskId,
          sessionId: payload.sessionId, attemptId: payload.attemptId,
          externalProfileRef: payload.environment.externalProfileRef,
          parameters: payload.environment.parameters,
          releasePolicyRef: payload.environment.releasePolicyRef,
          workAreas: payload.environment.workAreas, allowedPreparationEffects: [] });
        const receipt = await this.input.connectors.execution(item.installationId)
          .requestAllocation(actionContext(item), request);
        this.settle(item, receipt, (result) => this.allocationReady(item, payload, result),
          () => this.failDelegation(item, payload));
        return;
      }
      case "none": {
        const profile = this.input.execution.getProfile(
          item.workspaceId, payload.profileId, payload.profileRevision,
        );
        const open = OpenSessionInputSchema.parse({ hubSessionId: payload.sessionId,
          route: { kind: "external", route: { id: `external:${payload.sessionId}`,
            ownerInstallationId: profile.runtimeInstallationId, kind: "simulated_external" } },
          configuration: profile.configuration, requestedControl: "control",
          mode: "create", sessionLaunchOwner: "runtime_connector" });
        const receipt = await this.input.connectors.runtime(profile.runtimeInstallationId)
          .openSession(actionContext(item), open);
        this.settle(item, receipt, (result) => this.input.bindAndStart(item, payload, result),
          () => this.failDelegation(item, payload));
        return;
      }
    }
  }

  applyLookup(item: OutboxItem, result: unknown): void {
    const delegation = delegationSchema.parse(item.payload);
    if (delegation.environment.mode === "provision") {
      const allocation = z.strictObject({ allocationRef: NativeRefSchema,
        identity: ResourceIdentitySchema, lifecycleGrant: LifecycleGrantSchema,
        ready: z.boolean(), precreatedNativeSession: NativeRefSchema.optional() }).parse(result);
      this.allocationReady(item, delegation, allocation);
      return;
    }
    if (delegation.environment.mode === "none") {
      this.input.bindAndStart(item, delegation, result);
      return;
    }
    throw new TypeError("Existing-environment probes do not use operation lookup.");
  }

  private allocationReady(item: OutboxItem, delegation: DelegationPayload, allocation: {
    readonly allocationRef: z.infer<typeof NativeRefSchema>;
    readonly identity: z.infer<typeof ResourceIdentitySchema>;
    readonly lifecycleGrant: z.infer<typeof LifecycleGrantSchema>;
    readonly precreatedNativeSession?: z.infer<typeof NativeRefSchema> | undefined;
  }): void {
    if (this.input.state.stopRequested(item.workspaceId, delegation.attemptId)) {
      if (delegation.bindingId === undefined) throw new TypeError("Provisioned allocation is missing its binding.");
      this.input.environments.saveAllocationBinding({ workspaceId: item.workspaceId,
        bindingId: delegation.bindingId, sourceId: allocation.allocationRef.id,
        identity: allocation.identity, lifecycleGrant: allocation.lifecycleGrant });
      const payload = { attemptId: delegation.attemptId, bindingId: delegation.bindingId,
        allocationRef: allocation.allocationRef,
        identity: allocation.identity, lifecycleGrant: allocation.lifecycleGrant,
        releasePolicyRef: allocation.lifecycleGrant.releasePolicyRef };
      this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
        workType: "execution.releaseCanceledAllocation", connectorKind: "execution",
        installationId: item.installationId, stage: "release_canceled_allocation",
        targetId: delegation.attemptId, payload, inputDigest: digest(payload) });
      this.input.state.finishAttempt(item.workspaceId, delegation.attemptId, "canceled");
      return;
    }
    const selected = { ...delegation, ...(allocation.precreatedNativeSession ? { precreatedNativeSession: allocation.precreatedNativeSession } : {}) };
    if (delegation.bindingId === undefined) {
      throw new TypeError("Provisioned allocation is missing its binding.");
    }
    this.input.environments.saveAllocationBinding({ workspaceId: item.workspaceId,
      bindingId: delegation.bindingId, sourceId: allocation.allocationRef.id,
      identity: allocation.identity, lifecycleGrant: allocation.lifecycleGrant });
    this.input.environments.updateBindingState(item.workspaceId, delegation.bindingId, "waiting");
    this.enqueueAttachment(item, selected, { kind: "allocation",
      allocationRef: allocation.allocationRef, expectedIdentity: allocation.identity,
      lifecycleGrant: allocation.lifecycleGrant }, [allocation.lifecycleGrant.id]);
  }

  private enqueueAttachment(
    item: OutboxItem, delegation: DelegationPayload, target: object,
    authorizedGrantRefs: readonly string[],
  ): void {
    const payload = { delegation, target, authorizedGrantRefs };
    this.input.operations.addOutbox({ workspaceId: item.workspaceId, commandId: item.commandId,
      workType: "execution.attachForDelegation", connectorKind: "execution",
      installationId: item.installationId, stage: "attach_environment",
      ...(delegation.bindingId === undefined ? {} : { targetId: delegation.bindingId }),
      payload, inputDigest: digest(payload) });
  }

  applyFailure(item: OutboxItem): void {
    this.failDelegation(item, delegationSchema.parse(item.payload));
  }

  private failDelegation(item: OutboxItem, delegation: DelegationPayload): void {
    if (delegation.bindingId !== undefined) {
      this.input.environments.updateBindingState(item.workspaceId, delegation.bindingId, "failed");
    }
    this.input.state.finishAttempt(item.workspaceId, delegation.attemptId, "failed");
    this.input.state.closeSession(item.workspaceId, delegation.sessionId);
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
