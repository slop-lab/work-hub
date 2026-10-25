import { z } from "zod";

import { conflict, forbidden } from "../domain/errors.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";

type SelectedWorkArea = {
  readonly key: string;
  readonly path: string;
  readonly pathNamespace: string;
  readonly requestedAccess: "read" | "write";
  readonly preparation: "preserve_existing" | "provider_profile";
};

export function requireExistingSelection(input: {
  readonly registration: ReturnType<EnvironmentRepository["connectorRegistration"]>;
  readonly probeInput: Readonly<Record<string, unknown>> | undefined;
  readonly selected: readonly SelectedWorkArea[];
  readonly requestedAccess: "read" | "write";
  readonly now: string;
}): void {
  if (input.registration.verifiedIdentity === undefined || input.registration.verifiedAt === undefined) {
    throw conflict("registration_unverified", "The existing environment must be verified before use.");
  }
  if (input.probeInput === undefined) {
    throw conflict("registration_unverified", "The registration has no current verification grant.");
  }
  const probe = z.strictObject({
    observedState: z.string(), unmetRequirements: z.array(z.string()),
    availableWorkAreas: z.array(z.strictObject({
      key: z.string(), path: z.string(), pathNamespace: z.string(),
      requestedAccess: z.union([z.literal("read"), z.literal("write")]),
    }).passthrough()),
    availableUseGrant: z.strictObject({
      allowedWorkAreas: z.array(z.strictObject({
        key: z.string(), path: z.string(), pathNamespace: z.string(),
        requestedAccess: z.union([z.literal("read"), z.literal("write")]),
      }).passthrough()),
      enforcement: z.union([z.literal("enforced"), z.literal("advisory"), z.literal("unknown")]),
      exclusivity: z.union([z.literal("external_enforced"), z.literal("hub_only"), z.literal("none")]),
      expiresAt: z.string().optional(), limitations: z.array(z.string()),
    }).passthrough(),
  }).passthrough().parse(input.probeInput);
  if (probe.observedState !== "running" || probe.unmetRequirements.length > 0) {
    throw conflict("environment_not_ready", "The verified environment is not currently ready.");
  }
  if (probe.availableUseGrant.expiresAt !== undefined && probe.availableUseGrant.expiresAt <= input.now) {
    throw conflict("environment_grant_expired", "The verified environment grant has expired.");
  }
  if (input.requestedAccess === "write" && probe.availableUseGrant.enforcement !== "enforced") {
    throw forbidden("Write access is not enforced by the verified environment grant.");
  }
  if (input.requestedAccess === "write" && probe.availableUseGrant.exclusivity === "none") {
    throw conflict("known_external_activity", "Known external activity blocks a conflicting writer.");
  }
  if (input.registration.verifiedIdentity.assurance === "weak" &&
    !input.registration.weakIdentityExplicitlyAccepted) {
    throw conflict("weak_identity_confirmation_required", "Weak environment identity requires explicit acceptance.");
  }
  for (const area of input.selected) {
    const allowed = input.registration.allowedWorkAreas.find((candidate) =>
      candidate.key === area.key && candidate.path === area.path &&
      candidate.pathNamespace === area.pathNamespace,
    );
    if (allowed === undefined || area.preparation !== "preserve_existing") {
      throw forbidden("The selected work area is outside the verified registration grant.");
    }
    if (area.requestedAccess !== input.requestedAccess) {
      throw forbidden("Every selected work area must use the requested binding access mode.");
    }
    const effective = probe.availableUseGrant.allowedWorkAreas.find((candidate) =>
      candidate.key === area.key && candidate.path === area.path &&
      candidate.pathNamespace === area.pathNamespace,
    );
    if (effective === undefined ||
      (input.requestedAccess === "write" && effective.requestedAccess !== "write")) {
      throw forbidden("The current verified use grant does not allow the selected work area.");
    }
    if (input.requestedAccess === "write" && allowed.requestedAccess !== "write") {
      throw forbidden("The registration does not grant write access to the selected work area.");
    }
  }
}

export function existingReservationKeys(input: {
  readonly environments: EnvironmentRepository;
  readonly workspaceId: string;
  readonly registrationId: string;
  readonly workAreas: readonly { readonly key: string }[];
}): readonly string[] {
  const registration = input.environments.connectorRegistration(input.workspaceId, input.registrationId);
  const verification = z.strictObject({
    availableUseGrant: z.strictObject({
      exclusivity: z.union([z.literal("external_enforced"), z.literal("hub_only"), z.literal("none")]),
    }).passthrough(),
  }).passthrough().parse(input.environments.verification(input.workspaceId, input.registrationId));
  if (verification.availableUseGrant.exclusivity === "external_enforced") {
    return input.workAreas.map((area) => area.key);
  }
  const identity = registration.verifiedIdentity;
  if (identity === undefined) throw conflict("registration_unverified", "Verified identity is required.");
  return [`environment:${identity.native.installationId}:${identity.native.providerScope}:${identity.native.kind}:${identity.native.id}:${identity.native.incarnation ?? "weak"}`];
}
