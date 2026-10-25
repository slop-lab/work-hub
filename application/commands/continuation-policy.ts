import {
  EnvironmentUseGrantSchema,
  NativeRefSchema,
  RuntimeBindingDescriptorSchema,
  type WorkArea,
} from "../contracts/index.ts";
import type { Actor } from "../domain/authorization.ts";
import { requireProfile } from "../domain/authorization.ts";
import { conflict, unsupported } from "../domain/errors.ts";
import type { ExecutionProfileView } from "../domain/model.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import { requireRevision } from "./guards.ts";

type ContinuationPolicyDependencies = {
  readonly execution: ExecutionRepository;
  readonly environments: EnvironmentRepository;
  readonly state: StateRepository;
  readonly installationUsable: (workspaceId: string, installationId: string) => boolean;
  readonly runtimeSupports: (installationId: string, names: readonly string[]) => boolean;
  readonly now: () => Date;
};

export class ContinuationPolicy {
  private readonly dependencies: ContinuationPolicyDependencies;

  constructor(dependencies: ContinuationPolicyDependencies) {
    this.dependencies = dependencies;
  }

  profileForStart(actor: Actor, profileId: string, expectedRevision: number | undefined): ExecutionProfileView {
    requireProfile(actor, profileId);
    const profile = this.dependencies.execution.getProfile(actor.workspaceId, profileId);
    requireRevision(profile.revision, expectedRevision, "Profile");
    this.requireUsable(actor.workspaceId, profile);
    return profile;
  }

  private requireUsable(workspaceId: string, profile: ExecutionProfileView): void {
    if (!profile.enabled) throw unsupported("profile_disabled", "The selected execution profile is disabled.");
    if (!this.dependencies.installationUsable(workspaceId, profile.runtimeInstallationId)) {
      throw unsupported("connector_disabled", "The selected runtime installation is disabled or unavailable.");
    }
    if (!this.dependencies.runtimeSupports(profile.runtimeInstallationId, profile.requiredCapabilities)) {
      throw unsupported("required_capability_unavailable", "The runtime no longer supports the selected profile.");
    }
  }

  requireContinuationCapability(capabilities: Readonly<Record<string, unknown>>): void {
    const capability = capabilities["continueNativeSession"];
    if (capability !== "supported" &&
      !(typeof capability === "object" && capability !== null && Reflect.get(capability, "support") === "supported")) {
      throw unsupported("continuation_unsupported", "The runtime cannot continue this native session.");
    }
  }

  runtimeAndEnvironment(
    workspaceId: string,
    sessionId: string,
    profile: ExecutionProfileView,
    reuse: "reuse" | "reattach",
  ): readonly WorkArea[] {
    if (reuse === "reattach") {
      throw unsupported("continuation_reattach_unsupported", "Reattach is not implemented; start a new-session handoff instead.");
    }
    const session = this.dependencies.execution.getSession(workspaceId, sessionId);
    const runtime = this.dependencies.state.runtimeBindingRecord(workspaceId, sessionId);
    const descriptor = RuntimeBindingDescriptorSchema.parse(runtime.descriptor);
    if (runtime.generation !== session.bindingGeneration) {
      throw conflict("binding_generation_conflict", "The runtime binding generation changed.");
    }
    const nativeSession = NativeRefSchema.parse(JSON.parse(session.nativeIdentityKey ?? "null"));
    if (JSON.stringify(nativeSession) !== JSON.stringify(descriptor.nativeSession)) {
      throw conflict("native_identity_conflict", "The verified native session identity changed.");
    }
    const grant = descriptor.controlGrant;
    if (grant.mode !== "control" || !grant.allowedActions.includes("start_attempt")) {
      throw unsupported("start_attempt_not_authorized", "The runtime grant cannot start another attempt.");
    }
    if (grant.expiresAt !== undefined && grant.expiresAt <= this.dependencies.now().toISOString()) {
      throw conflict("runtime_control_expired", "The runtime control grant has expired.");
    }
    const bindings = this.dependencies.environments.listBindings(workspaceId)
      .filter((binding) => binding.sessionId === sessionId);
    if (bindings.length === 0) {
      if (!profile.allowedEnvironmentModes.includes("none")) {
        throw unsupported("environment_mode_unsupported", "The profile does not allow continuation without an environment.");
      }
      return [];
    }
    const attached = bindings.filter((binding) => binding.state === "attached");
    if (attached.length !== 1) {
      throw conflict("continuation_requires_reattach", "The prior environment is detached or unavailable; use a new-session handoff.");
    }
    const binding = attached[0];
    if (binding === undefined || binding.useGrant === undefined) {
      throw conflict("environment_grant_missing", "The attached environment has no verified use grant.");
    }
    const mode = binding.sourceKind === "registration" ? "existing" : "provision";
    if (!profile.allowedEnvironmentModes.includes(mode)) {
      throw unsupported("environment_mode_unsupported", "The profile does not allow reuse of this environment mode.");
    }
    const useGrant = EnvironmentUseGrantSchema.parse(binding.useGrant);
    if (useGrant.expiresAt !== undefined && useGrant.expiresAt <= this.dependencies.now().toISOString()) {
      throw conflict("environment_grant_expired", "The environment use grant has expired.");
    }
    return useGrant.allowedWorkAreas;
  }
}
