import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type {
  EnvironmentBindingView,
  EnvironmentRegistrationView,
} from "../domain/model.ts";
import { ExistingEnvironmentRegistrationSchema } from "../contracts/index.ts";
import { EnvironmentAttachmentSchema, LifecycleGrantSchema } from "../contracts/index.ts";
import type { EnvironmentAttachment, ExistingEnvironmentRegistration, LifecycleGrant } from "../contracts/index.ts";
import type { Clock } from "./codec.ts";
import { newId, parseJson } from "./codec.ts";

const objectSchema = z.record(z.string(), z.unknown());
const objectListSchema = z.array(objectSchema);
const registrationRowSchema = z.strictObject({
  id: z.string(), workspaceId: z.string(), revision: z.number(), label: z.string(),
  executionInstallationId: z.string(), allowedProjectIdsJson: z.string(),
  allowedWorkAreasJson: z.string(), allowRuntimeServiceLaunch: z.number(),
  verifiedIdentityJson: z.string().nullable(), verifiedAt: z.string().nullable(),
  weakIdentityAccepted: z.number(), retiredAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
const bindingRowSchema = z.strictObject({
  id: z.string(), workspaceId: z.string(), sessionId: z.string(),
  attemptId: z.string().nullable(), sourceKind: z.union([z.literal("registration"), z.literal("allocation")]),
  sourceId: z.string().nullable(), identityJson: z.string().nullable(),
  lifecycleGrantJson: z.string().nullable(), useGrantJson: z.string().nullable(),
  workAreaKeysJson: z.string(), accessMode: z.union([z.literal("read"), z.literal("write")]),
  generation: z.number(),
  state: z.union([
    z.literal("requested"), z.literal("waiting"), z.literal("attached"),
    z.literal("detaching"), z.literal("detached"), z.literal("releasing"),
    z.literal("released"), z.literal("failed"),
  ]),
  createdAt: z.string(), updatedAt: z.string(),
});

function registrationFromRow(row: unknown): EnvironmentRegistrationView {
  const value = registrationRowSchema.parse(row);
  return {
    id: value.id, workspaceId: value.workspaceId, revision: value.revision,
    label: value.label, executionInstallationId: value.executionInstallationId,
    allowedProjectIds: z.array(z.string()).parse(parseJson(value.allowedProjectIdsJson)),
    allowedWorkAreas: objectListSchema.parse(parseJson(value.allowedWorkAreasJson)),
    allowRuntimeServiceLaunch: value.allowRuntimeServiceLaunch === 1,
    ...(value.verifiedIdentityJson === null ? {} : {
      verifiedIdentity: objectSchema.parse(parseJson(value.verifiedIdentityJson)),
    }),
    ...(value.verifiedAt === null ? {} : { verifiedAt: value.verifiedAt }),
    weakIdentityExplicitlyAccepted: value.weakIdentityAccepted === 1,
    ...(value.retiredAt === null ? {} : { retiredAt: value.retiredAt }),
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function bindingFromRow(row: unknown): EnvironmentBindingView {
  const value = bindingRowSchema.parse(row);
  return {
    id: value.id, workspaceId: value.workspaceId, sessionId: value.sessionId,
    ...(value.attemptId === null ? {} : { attemptId: value.attemptId }),
    sourceKind: value.sourceKind,
    ...(value.sourceId === null ? {} : { sourceId: value.sourceId }),
    ...(value.identityJson === null ? {} : { identity: objectSchema.parse(parseJson(value.identityJson)) }),
    ...(value.lifecycleGrantJson === null ? {} : {
      lifecycleGrant: objectSchema.parse(parseJson(value.lifecycleGrantJson)),
    }),
    ...(value.useGrantJson === null ? {} : { useGrant: objectSchema.parse(parseJson(value.useGrantJson)) }),
    workAreaKeys: z.array(z.string()).parse(parseJson(value.workAreaKeysJson)),
    accessMode: value.accessMode, generation: value.generation, state: value.state,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

const registrationSelect = `SELECT id, workspace_id AS workspaceId, revision, label,
  execution_installation_id AS executionInstallationId,
  allowed_project_ids_json AS allowedProjectIdsJson,
  allowed_work_areas_json AS allowedWorkAreasJson,
  allow_runtime_service_launch AS allowRuntimeServiceLaunch,
  verified_identity_json AS verifiedIdentityJson, verified_at AS verifiedAt,
  weak_identity_accepted AS weakIdentityAccepted, retired_at AS retiredAt,
  created_at AS createdAt, updated_at AS updatedAt FROM environment_registrations`;
const bindingSelect = `SELECT id, workspace_id AS workspaceId, session_id AS sessionId,
  attempt_id AS attemptId, source_kind AS sourceKind, source_id AS sourceId,
  identity_json AS identityJson, lifecycle_grant_json AS lifecycleGrantJson,
  use_grant_json AS useGrantJson, work_area_keys_json AS workAreaKeysJson,
  access_mode AS accessMode, generation, state, created_at AS createdAt,
  updated_at AS updatedAt FROM environment_bindings`;

export class EnvironmentRepository {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(database: DatabaseSync, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  createRegistration(input: {
    readonly workspaceId: string; readonly label: string; readonly executionInstallationId: string;
    readonly locator: object; readonly secretRefs: readonly object[];
    readonly allowedProjectIds: readonly string[]; readonly allowedWorkAreas: readonly object[];
    readonly allowRuntimeServiceLaunch: boolean; readonly weakIdentityExplicitlyAccepted: boolean;
  }): EnvironmentRegistrationView {
    const id = newId("registration");
    const now = this.clock.now().toISOString();
    this.database.prepare(`INSERT INTO environment_registrations
      (id, workspace_id, revision, label, execution_installation_id, locator_json,
       secret_refs_json, allowed_project_ids_json, allowed_work_areas_json,
       allow_runtime_service_launch, weak_identity_accepted, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.workspaceId, input.label, input.executionInstallationId,
      JSON.stringify(input.locator), JSON.stringify(input.secretRefs),
      JSON.stringify(input.allowedProjectIds), JSON.stringify(input.allowedWorkAreas),
      input.allowRuntimeServiceLaunch ? 1 : 0,
      input.weakIdentityExplicitlyAccepted ? 1 : 0, now, now,
    );
    return this.getRegistration(input.workspaceId, id);
  }

  getRegistration(workspaceId: string, id: string): EnvironmentRegistrationView {
    return registrationFromRow(this.database.prepare(
      `${registrationSelect} WHERE workspace_id = ? AND id = ?`,
    ).get(workspaceId, id));
  }

  connectorRegistration(workspaceId: string, id: string): ExistingEnvironmentRegistration {
    const row = z.strictObject({
      id: z.string(), revision: z.number(), label: z.string(),
      executionInstallationId: z.string(), locatorJson: z.string(), secretRefsJson: z.string(),
      allowedProjectIdsJson: z.string(), allowedWorkAreasJson: z.string(),
      allowRuntimeServiceLaunch: z.number(), verifiedIdentityJson: z.string().nullable(),
      verifiedAt: z.string().nullable(), weakIdentityAccepted: z.number(), retiredAt: z.string().nullable(),
    }).parse(this.database.prepare(`SELECT id, revision, label,
      execution_installation_id AS executionInstallationId, locator_json AS locatorJson,
      secret_refs_json AS secretRefsJson, allowed_project_ids_json AS allowedProjectIdsJson,
      allowed_work_areas_json AS allowedWorkAreasJson,
      allow_runtime_service_launch AS allowRuntimeServiceLaunch,
      verified_identity_json AS verifiedIdentityJson, verified_at AS verifiedAt,
      weak_identity_accepted AS weakIdentityAccepted, retired_at AS retiredAt
      FROM environment_registrations WHERE workspace_id = ? AND id = ?`).get(workspaceId, id));
    return ExistingEnvironmentRegistrationSchema.parse({
      id: row.id, revision: row.revision, label: row.label,
      executionInstallationId: row.executionInstallationId,
      locator: parseJson(row.locatorJson), secretRefs: parseJson(row.secretRefsJson),
      allowedProjectIds: parseJson(row.allowedProjectIdsJson),
      allowedWorkAreas: parseJson(row.allowedWorkAreasJson),
      allowRuntimeServiceLaunch: row.allowRuntimeServiceLaunch === 1,
      ...(row.verifiedIdentityJson === null ? {} : { verifiedIdentity: parseJson(row.verifiedIdentityJson) }),
      ...(row.verifiedAt === null ? {} : { verifiedAt: row.verifiedAt }),
      weakIdentityExplicitlyAccepted: row.weakIdentityAccepted === 1,
      ...(row.retiredAt === null ? {} : { retiredAt: row.retiredAt }),
    });
  }

  listRegistrations(workspaceId: string): readonly EnvironmentRegistrationView[] {
    return this.database.prepare(
      `${registrationSelect} WHERE workspace_id = ? ORDER BY updated_at DESC`,
    ).all(workspaceId).map(registrationFromRow);
  }

  saveVerification(workspaceId: string, id: string, identity: object): EnvironmentRegistrationView {
    const now = this.clock.now().toISOString();
    this.database.prepare(`UPDATE environment_registrations SET revision = revision + 1,
      verified_identity_json = ?, verified_at = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(JSON.stringify(identity), now, now, workspaceId, id);
    return this.getRegistration(workspaceId, id);
  }

  saveProbe(workspaceId: string, id: string, probe: {
    readonly identity: object; readonly observedState: string;
    readonly availableWorkAreas: readonly object[]; readonly availableUseGrant: object;
    readonly routeKinds: readonly string[]; readonly unmetRequirements: readonly string[];
  }): EnvironmentRegistrationView {
    const now = this.clock.now().toISOString();
    this.database.prepare(`UPDATE environment_registrations SET revision = revision + 1,
      verified_identity_json = ?, verification_json = ?, verified_at = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(
        JSON.stringify(probe.identity), JSON.stringify(probe), now, now, workspaceId, id,
      );
    return this.getRegistration(workspaceId, id);
  }

  verification(workspaceId: string, id: string): Readonly<Record<string, unknown>> | undefined {
    const row = z.strictObject({ verificationJson: z.string().nullable() }).parse(
      this.database.prepare(`SELECT verification_json AS verificationJson
        FROM environment_registrations WHERE workspace_id = ? AND id = ?`).get(workspaceId, id),
    );
    return row.verificationJson === null
      ? undefined
      : z.record(z.string(), z.unknown()).parse(parseJson(row.verificationJson));
  }

  retire(workspaceId: string, id: string): EnvironmentRegistrationView {
    const now = this.clock.now().toISOString();
    this.database.prepare(`UPDATE environment_registrations SET revision = revision + 1,
      retired_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(now, now, workspaceId, id);
    return this.getRegistration(workspaceId, id);
  }

  getBinding(workspaceId: string, id: string): EnvironmentBindingView {
    return bindingFromRow(this.database.prepare(
      `${bindingSelect} WHERE workspace_id = ? AND id = ?`,
    ).get(workspaceId, id));
  }

  listBindings(workspaceId: string): readonly EnvironmentBindingView[] {
    return this.database.prepare(`${bindingSelect} WHERE workspace_id = ? ORDER BY updated_at DESC`)
      .all(workspaceId).map(bindingFromRow);
  }

  connectorBinding(workspaceId: string, id: string): {
    readonly binding: EnvironmentBindingView;
    readonly attachment: EnvironmentAttachment;
    readonly lifecycleGrant?: LifecycleGrant;
  } {
    const row = z.strictObject({ attachmentJson: z.string(), lifecycleGrantJson: z.string().nullable() })
      .parse(this.database.prepare(`SELECT attachment_json AS attachmentJson,
        lifecycle_grant_json AS lifecycleGrantJson FROM environment_bindings
        WHERE workspace_id = ? AND id = ?`).get(workspaceId, id));
    return {
      binding: this.getBinding(workspaceId, id),
      attachment: EnvironmentAttachmentSchema.parse(parseJson(row.attachmentJson)),
      ...(row.lifecycleGrantJson === null ? {} : {
        lifecycleGrant: LifecycleGrantSchema.parse(parseJson(row.lifecycleGrantJson)),
      }),
    };
  }

  hasOtherActiveIdentityBinding(
    workspaceId: string,
    bindingId: string,
    nativeId: string,
    incarnation?: string,
  ): boolean {
    return this.database.prepare(`SELECT 1 FROM environment_bindings WHERE workspace_id = ?
      AND id <> ? AND state NOT IN ('detached','released','failed')
      AND json_extract(identity_json, '$.native.id') = ?
      AND COALESCE(json_extract(identity_json, '$.native.incarnation'), '') = ? LIMIT 1`)
      .get(workspaceId, bindingId, nativeId, incarnation ?? "") !== undefined;
  }

  updateBindingState(workspaceId: string, id: string, state: EnvironmentBindingView["state"]): void {
    this.database.prepare(`UPDATE environment_bindings SET state = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(state, this.clock.now().toISOString(), workspaceId, id);
  }

  saveAllocationBinding(input: { readonly workspaceId: string; readonly bindingId: string; readonly sourceId: string; readonly identity: object; readonly lifecycleGrant: object }): void {
    this.database.prepare(`UPDATE environment_bindings SET source_id = ?, identity_json = ?, lifecycle_grant_json = ?, state = 'releasing', updated_at = ? WHERE workspace_id = ? AND id = ? AND source_kind = 'allocation'`)
      .run(input.sourceId, JSON.stringify(input.identity), JSON.stringify(input.lifecycleGrant), this.clock.now().toISOString(), input.workspaceId, input.bindingId);
  }

  createBinding(input: {
    readonly workspaceId: string; readonly sessionId: string; readonly attemptId?: string;
    readonly sourceKind: "registration" | "allocation"; readonly sourceId?: string;
    readonly workAreaKeys: readonly string[]; readonly accessMode: "read" | "write";
  }): EnvironmentBindingView {
    const id = newId("binding");
    const now = this.clock.now().toISOString();
    this.database.prepare(`INSERT INTO environment_bindings
      (id, workspace_id, session_id, attempt_id, source_kind, source_id,
       work_area_keys_json, access_mode, generation, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'requested', ?, ?)`).run(
      id, input.workspaceId, input.sessionId, input.attemptId ?? null,
      input.sourceKind, input.sourceId ?? null, JSON.stringify(input.workAreaKeys),
      input.accessMode, now, now,
    );
    return this.getBinding(input.workspaceId, id);
  }
}
