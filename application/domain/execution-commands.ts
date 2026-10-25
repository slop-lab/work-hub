import { z } from "zod";

import {
  envelope,
  environmentSelectionSchema,
  idSchema,
  jsonObjectSchema,
  nativeRefSchema,
  textSchema,
  workAreaSchema,
} from "./schema-common.ts";

export const executionCommandSchemas = [
  envelope('attempt.report', z.strictObject({ phase: z.enum(['running', 'waiting_input', 'ended', 'unknown']), note: textSchema.optional() })),
  envelope(
    "environment.register",
    z.strictObject({
      label: z.string().min(1).max(512),
      executionInstallationId: idSchema,
      locator: jsonObjectSchema,
      secretRefs: z.array(z.strictObject({ id: idSchema, purpose: idSchema })).default([]),
      allowedProjectIds: z.array(idSchema).min(1),
      allowedWorkAreas: z.array(workAreaSchema),
      allowRuntimeServiceLaunch: z.boolean(),
      weakIdentityExplicitlyAccepted: z.boolean().default(false),
    }),
  ),
  envelope("environment.verify", z.strictObject({})),
  envelope("environment.retire", z.strictObject({ reason: textSchema.min(1) })),
  envelope(
    "attempt.delegate",
    z.strictObject({
      profileId: idSchema,
      environment: environmentSelectionSchema,
      instruction: textSchema.optional(),
      selectedReferenceIds: z.array(idSchema),
      selectedResponseIds: z.array(idSchema),
      authorizedEffectKinds: z.array(idSchema).default([]),
    }),
  ),
  envelope(
    "session.attach",
    z.strictObject({
      profileId: idSchema,
      controlMode: z.union([z.literal("observe"), z.literal("control")]),
      nativeSession: nativeRefSchema,
      environment: environmentSelectionSchema,
    }),
  ),
  envelope(
    "session.takeControl",
    z.strictObject({ requestedActions: z.array(idSchema) }),
  ),
  envelope(
    "session.instruct",
    z.strictObject({
      attemptId: idSchema,
      text: textSchema.min(1),
      referenceIds: z.array(idSchema),
      mode: z.union([z.literal("immediate"), z.literal("runtime_queued")]),
    }),
  ),
  envelope(
    "session.continue",
    z.strictObject({
      profileId: idSchema,
      context: z.union([z.literal("snapshot"), z.literal("current_task")]),
      environmentReuse: z.union([z.literal("reuse"), z.literal("reattach")]),
      instruction: textSchema.min(1),
      sourceResultId: idSchema.optional(),
    }),
  ),
  envelope(
    "attempt.retry",
    z.strictObject({
      predecessorId: idSchema,
      profileId: idSchema.optional(),
      input: z.union([z.literal("snapshot"), z.literal("current_task")]),
      recoveryDecisionId: idSchema.optional(),
      sameSession: z.boolean().default(false),
      environment: environmentSelectionSchema.optional(),
    }),
  ),
  envelope(
    "attempt.stop",
    z.strictObject({
      mode: z.union([
        z.literal("interrupt"),
        z.literal("stop_work"),
        z.literal("terminate_session_process"),
      ]),
      reason: textSchema.optional(),
    }),
  ),
  envelope("session.close", z.strictObject({ externalWorkDecision: z.literal("continues").optional() })),
  envelope("environment.detach", z.strictObject({ reason: textSchema.optional() })),
  envelope(
    "environment.release",
    z.strictObject({
      preservationDecisionRef: idSchema,
      operatorDecisionRef: idSchema.optional(),
    }),
  ),
  envelope("operation.reconcile", z.strictObject({})),
] as const;
