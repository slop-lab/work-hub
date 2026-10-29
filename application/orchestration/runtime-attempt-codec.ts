import { z } from "zod";

import {
  InputSnapshotSchema,
  NativeRefSchema,
  type InputSnapshot,
  type WorkArea,
  WorkAreaSchema,
} from "../contracts/index.ts";
import type { StateRepository } from "../persistence/state-repository.ts";

export function runtimeInputSnapshot(input: z.infer<typeof InputSnapshotSchema>): InputSnapshot {
  return {
    id: input.id, digest: input.digest, taskId: input.taskId, taskRevision: input.taskRevision,
    scopeRevision: input.scopeRevision,
    profileId: input.profileId, profileRevision: input.profileRevision,
    instruction: input.instruction, selectedReferenceIds: input.selectedReferenceIds,
    selectedResponseIds: input.selectedResponseIds,
    contextItems: input.contextItems.map((item) => ({
      sourceId: item.sourceId,
      ...(item.sourceRevision === undefined ? {} : { sourceRevision: item.sourceRevision }),
      ...(item.includedText === undefined ? {} : { includedText: item.includedText }),
      ...(item.retainedContentRef === undefined ? {} : { retainedContentRef: item.retainedContentRef }),
      ...(item.omissionReason === undefined ? {} : { omissionReason: item.omissionReason }),
    })),
    authorizedEffectKinds: input.authorizedEffectKinds, assembledAt: input.assembledAt,
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.promptDigest === undefined ? {} : { promptDigest: input.promptDigest }),
  };
}

export function runtimeWorkAreas(
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

export function nativeExecutionTarget(
  state: StateRepository,
  workspaceId: string,
  attemptId: string,
): { readonly nativeExecutionRef?: z.infer<typeof NativeRefSchema> } {
  const stored = state.attemptNativeExecution(workspaceId, attemptId);
  return stored === undefined ? {} : { nativeExecutionRef: NativeRefSchema.parse(stored) };
}
