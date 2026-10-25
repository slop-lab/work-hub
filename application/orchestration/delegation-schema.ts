import { z } from "zod";

import { InputSnapshotSchema, type WorkArea, WorkAreaSchema, NativeRefSchema } from "../contracts/index.ts";
import { environmentSelectionSchema } from "../domain/schema-common.ts";

export const delegationSchema = z.strictObject({
  taskId: z.string(), sessionId: z.string(), attemptId: z.string(),
  profileId: z.string(), profileRevision: z.number(),
  environment: environmentSelectionSchema, bindingId: z.string().optional(),
  inputSnapshot: InputSnapshotSchema,
  precreatedNativeSession: NativeRefSchema.optional(),
});

export type DelegationPayload = z.infer<typeof delegationSchema>;

export function delegationWorkAreas(
  input: readonly z.infer<typeof WorkAreaSchema>[],
): readonly WorkArea[] {
  return input.map((area) => ({
    key: area.key, path: area.path, pathNamespace: area.pathNamespace,
    requestedAccess: area.requestedAccess, preparation: area.preparation,
    ...(area.expectedContentRevision === undefined ? {} : {
      expectedContentRevision: area.expectedContentRevision,
    }),
  }));
}
