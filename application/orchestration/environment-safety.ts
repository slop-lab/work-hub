import type {
  EnvironmentAttachment,
  EnvironmentProbe,
  EnvironmentSelection,
  ExistingEnvironmentRegistration,
  ResourceIdentity,
} from "../contracts/index.ts";

export function attachmentHonorsSelection(input: {
  readonly attachment: EnvironmentAttachment;
  readonly expectedIdentity: ResourceIdentity;
  readonly requestedAccess: "read" | "write";
  readonly workAreas: readonly { readonly key: string; readonly path: string; readonly pathNamespace: string; readonly requestedAccess?: 'read' | 'write'; readonly preparation?: 'preserve_existing' | 'provider_profile' }[];
  readonly now: string;
}): boolean {
  if (!sameResourceIdentity(input.expectedIdentity, input.attachment.identity) ||
    (input.attachment.useGrant.expiresAt !== undefined &&
      input.attachment.useGrant.expiresAt <= input.now)) return false;
  if (input.requestedAccess === "write" &&
    (input.attachment.useGrant.enforcement !== "enforced" ||
       input.attachment.useGrant.exclusivity === "none")) return false;
  if (input.attachment.useGrant.allowedWorkAreas.length !== input.workAreas.length ||
    input.attachment.useGrant.allowedWorkAreas.some((granted) => !input.workAreas.some((selected) =>
      sameArea(granted, selected) && granted.requestedAccess === (selected.requestedAccess ?? input.requestedAccess) &&
      (selected.preparation === undefined || granted.preparation === selected.preparation)))) return false;
  return input.workAreas.every((selected) => {
    const granted = input.attachment.useGrant.allowedWorkAreas.find((area) => sameArea(area, selected));
    return granted !== undefined &&
      (input.requestedAccess === "read" || granted.requestedAccess === "write");
  });
}

export function verifiedExistingTarget(input: {
  readonly registration: ExistingEnvironmentRegistration;
  readonly priorIdentity: ResourceIdentity;
  readonly probe: EnvironmentProbe;
  readonly selection: Extract<EnvironmentSelection, { readonly mode: "existing" }>;
  readonly now: string;
}): boolean {
  if (!sameResourceIdentity(input.priorIdentity, input.probe.identity) ||
    input.probe.observedState !== "running" || input.probe.unmetRequirements.length > 0 ||
    (input.probe.availableUseGrant.expiresAt !== undefined &&
      input.probe.availableUseGrant.expiresAt <= input.now) ||
    (input.probe.identity.assurance === "weak" && !input.registration.weakIdentityExplicitlyAccepted)) {
    return false;
  }
  if (input.selection.requestedAccess === "write" &&
    (input.probe.availableUseGrant.enforcement !== "enforced" ||
      input.probe.availableUseGrant.exclusivity === "none")) {
    return false;
  }
  return input.selection.workAreas.every((selected) => {
    if (selected.preparation !== "preserve_existing" ||
      selected.requestedAccess !== input.selection.requestedAccess) return false;
    const registered = input.registration.allowedWorkAreas.find((area) => sameArea(area, selected));
    const current = input.probe.availableUseGrant.allowedWorkAreas.find((area) => sameArea(area, selected));
    return registered !== undefined && current !== undefined &&
      (selected.requestedAccess === "read" ||
        (registered.requestedAccess === "write" && current.requestedAccess === "write"));
  });
}

export function sameResourceIdentity(left: ResourceIdentity, right: ResourceIdentity): boolean {
  return left.native.installationId === right.native.installationId &&
    left.native.providerScope === right.native.providerScope && left.native.kind === right.native.kind &&
    left.native.id === right.native.id && left.native.incarnation === right.native.incarnation &&
    left.assurance === right.assurance;
}

function sameArea(
  left: { readonly key: string; readonly path: string; readonly pathNamespace: string },
  right: { readonly key: string; readonly path: string; readonly pathNamespace: string },
): boolean {
  return left.key === right.key && left.path === right.path &&
    left.pathNamespace === right.pathNamespace;
}
