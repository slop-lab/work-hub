import { z } from "zod";
import type { NativeRef, RuntimeTarget } from "../contracts/index.ts";

export const nativeRefSchema = z.strictObject({
  installationId: z.string(), providerScope: z.string(), kind: z.string(), id: z.string(),
  incarnation: z.string().optional(),
});
export const routeSchema = z.strictObject({
  id: z.string(), ownerInstallationId: z.string(), kind: z.string(), expiresAt: z.string().optional(),
});
export const controlGrantSchema = z.strictObject({
  id: z.string(), mode: z.union([z.literal("observe"), z.literal("control")]),
  allowedActions: z.array(z.union([
    z.literal("start_attempt"), z.literal("send_instruction"), z.literal("deliver_response"),
    z.literal("request_stop"), z.literal("interactive_input"),
  ])),
  expiresAt: z.string().optional(), externalClientsMayAlsoControl: z.boolean(),
});
export const bindingDescriptorSchema = z.strictObject({
  nativeSession: nativeRefSchema,
  nativeIdentityAssurance: z.union([z.literal("immutable"), z.literal("attested"), z.literal("weak")]),
  origin: z.union([z.literal("created"), z.literal("attached_existing"), z.literal("provider_precreated")]),
  route: routeSchema,
  controlGrant: controlGrantSchema,
  capabilities: z.record(z.string(), z.unknown()),
  history: z.union([
    z.literal("complete_available"), z.literal("partial"), z.literal("live_only"), z.literal("unavailable"),
  ]),
});

export function runtimeTarget(descriptorInput: Readonly<Record<string, unknown>>, input: {
  readonly sessionId: string; readonly generation: number;
}): RuntimeTarget {
  const descriptor = bindingDescriptorSchema.parse(descriptorInput);
  return {
    hubSessionId: input.sessionId,
    nativeSession: nativeRef(descriptor.nativeSession),
    bindingGeneration: input.generation,
    controlGrantRef: descriptor.controlGrant.id,
  };
}

export function nativeRef(input: z.infer<typeof nativeRefSchema>): NativeRef {
  return {
    installationId: input.installationId, providerScope: input.providerScope,
    kind: input.kind, id: input.id,
    ...(input.incarnation === undefined ? {} : { incarnation: input.incarnation }),
  };
}
