import { z } from "zod";

export const idSchema = z.string().min(1).max(256);
export const textSchema = z.string().max(131_072);
export const jsonObjectSchema = z.record(z.string(), z.json());
export const targetSchema = z.strictObject({ kind: idSchema, id: idSchema });
export const expectedSchema = z
  .strictObject({
    task: z.number().int().positive().optional(),
    profile: z.number().int().positive().optional(),
    request: z.number().int().positive().optional(),
    registration: z.number().int().positive().optional(),
    session: z.number().int().positive().optional(),
    bindingGeneration: z.number().int().positive().optional(),
  })
  .optional();

export const recipientSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userId: idSchema }),
  z.strictObject({ kind: z.literal("project_members"), projectId: idSchema }),
  z.strictObject({ kind: z.literal("agent_session"), sessionId: idSchema }),
]);

export const answerSchemaSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    minLength: z.number().int().nonnegative(),
    maxLength: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("single_choice"),
    options: z
      .array(z.strictObject({ id: idSchema, label: z.string().min(1).max(512) }))
      .min(1)
      .max(100)
      .refine((options) => new Set(options.map((option) => option.id)).size === options.length, 'Choice IDs must be unique.'),
  }),
  z.strictObject({
    kind: z.literal("approval"),
    allowed: z.tuple([z.literal("approve"), z.literal("deny")]),
  }),
]);

export const answerValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: textSchema }),
  z.strictObject({ kind: z.literal("single_choice"), optionId: idSchema }),
  z.strictObject({
    kind: z.literal("approval"),
    decision: z.union([z.literal("approve"), z.literal("deny")]),
    note: textSchema.optional(),
  }),
]);

export const workAreaSchema = z.strictObject({
  key: idSchema,
  path: z.string().min(1).max(4096),
  pathNamespace: idSchema,
  requestedAccess: z.union([z.literal("read"), z.literal("write")]),
  preparation: z.union([z.literal("preserve_existing"), z.literal("provider_profile")]),
  expectedContentRevision: z.string().max(512).optional(),
});

export const environmentSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({
    mode: z.literal("provision"),
    executionInstallationId: idSchema,
    externalProfileRef: idSchema,
    parameters: jsonObjectSchema,
    releasePolicyRef: idSchema,
    workAreas: z.array(workAreaSchema),
  }),
  z.strictObject({
    mode: z.literal("existing"),
    registrationId: idSchema,
    expectedRegistrationRevision: z.number().int().positive(),
    workAreas: z.array(workAreaSchema),
    requestedAccess: z.union([z.literal("read"), z.literal("write")]),
  }),
]);

export const nativeRefSchema = z.strictObject({
  installationId: idSchema,
  providerScope: idSchema,
  kind: idSchema,
  id: idSchema,
  incarnation: z.string().max(512).optional(),
});

export function envelope<T extends string, S extends z.ZodType>(type: T, payload: S) {
  return z.strictObject({
    commandId: idSchema,
    type: z.literal(type),
    target: targetSchema.optional(),
    expected: expectedSchema,
    payload,
  });
}
