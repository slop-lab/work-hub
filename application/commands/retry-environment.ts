import { z } from "zod";

import type { Actor } from "../domain/authorization.ts";
import { forbidden, unsupported } from "../domain/errors.ts";
import type { ExecutionProfileView, TaskView } from "../domain/model.ts";
import { environmentSelectionSchema } from "../domain/schema-common.ts";
import type { EnvironmentRepository } from "../persistence/environment-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import { existingReservationKeys, requireExistingSelection } from "./execution-selection.ts";
import { requireRevision } from "./guards.ts";

type RetryEnvironment = z.infer<typeof environmentSelectionSchema>;

export function prepareRetryEnvironment(input: {
  readonly actor: Actor;
  readonly task: TaskView;
  readonly profile: ExecutionProfileView;
  readonly requested?: RetryEnvironment | undefined;
  readonly expectedRegistrationRevision?: number | undefined;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly environments: EnvironmentRepository;
  readonly state: StateRepository;
  readonly now: Date;
}): {
  readonly environment: RetryEnvironment;
  readonly bindingId?: string | undefined;
  readonly connectorKind: "runtime" | "execution";
  readonly installationId: string;
} {
  const environment = input.requested ?? environmentSelectionSchema.parse(input.profile.defaultEnvironment);
  if (!input.profile.allowedEnvironmentModes.includes(environment.mode)) {
    throw unsupported("environment_mode_unsupported", "The profile default environment mode is not allowed.");
  }
  const requestsWrite = environment.mode === "existing"
    ? environment.requestedAccess === "write"
    : environment.mode === "provision" &&
      environment.workAreas.some((area) => area.requestedAccess === "write");
  if (requestsWrite && !input.profile.allowedEffects.includes("work.write")) {
    throw forbidden("The retry environment requests writes outside the selected profile grant.");
  }

  let bindingId: string | undefined;
  let installationId = input.profile.runtimeInstallationId;
  if (environment.mode === "existing") {
    const registration = input.environments.getRegistration(
      input.actor.workspaceId, environment.registrationId,
    );
    requireRevision(registration.revision, environment.expectedRegistrationRevision, "Registration");
    if (input.requested !== undefined) {
      requireRevision(registration.revision, input.expectedRegistrationRevision, "Registration");
    }
    if (registration.retiredAt !== undefined ||
      !registration.allowedProjectIds.includes(input.task.projectId)) {
      throw forbidden("The profile default environment is not available to this project.");
    }
    requireExistingSelection({
      registration: input.environments.connectorRegistration(input.actor.workspaceId, registration.id),
      probeInput: input.environments.verification(input.actor.workspaceId, registration.id),
      selected: environment.workAreas, requestedAccess: environment.requestedAccess,
      now: input.now.toISOString(),
    });
    bindingId = input.environments.createBinding({
      workspaceId: input.actor.workspaceId, sessionId: input.sessionId,
      attemptId: input.attemptId, sourceKind: "registration", sourceId: registration.id,
      workAreaKeys: environment.workAreas.map((area) => area.key),
      accessMode: environment.requestedAccess,
    }).id;
    installationId = registration.executionInstallationId;
  }
  if (environment.mode === "provision") {
    bindingId = input.environments.createBinding({
      workspaceId: input.actor.workspaceId, sessionId: input.sessionId,
      attemptId: input.attemptId, sourceKind: "allocation",
      workAreaKeys: environment.workAreas.map((area) => area.key),
      accessMode: environment.workAreas.some((area) => area.requestedAccess === "write")
        ? "write" : "read",
    }).id;
    installationId = environment.executionInstallationId;
  }
  if (environment.mode !== "none") {
    const reservationKeys = environment.mode === "existing"
      ? existingReservationKeys({ environments: input.environments,
          workspaceId: input.actor.workspaceId, registrationId: environment.registrationId,
          workAreas: environment.workAreas })
      : environment.workAreas.map((area) => area.key);
    for (const resourceKey of reservationKeys) {
      input.state.addReservation({
        workspaceId: input.actor.workspaceId, attemptId: input.attemptId, resourceKey,
        mode: environment.mode === "existing" ? environment.requestedAccess
          : environment.workAreas.some((area) => area.requestedAccess === "write")
            ? "write" : "read",
        assurance: "hub_only",
      });
    }
  }
  return { environment, ...(bindingId === undefined ? {} : { bindingId }),
    connectorKind: environment.mode === "none" ? "runtime" : "execution", installationId };
}
