import type { ActionContext, CallContext } from "../contracts/index.ts";
import type { OutboxItem } from "../persistence/operation-repository.ts";

export function callContext(item: OutboxItem): CallContext {
  return {
    workspaceId: item.workspaceId,
    installationId: item.installationId,
    correlationId: item.commandId,
  };
}

export function actionContext(item: OutboxItem, authorizedGrantRefs: readonly string[] = []): ActionContext {
  if (item.operationId === undefined) {
    throw new TypeError("External operation is missing its persisted operation ID.");
  }
  return {
    ...callContext(item),
    commandId: item.commandId,
    operationId: item.operationId,
    inputDigest: item.inputDigest,
    authorizedGrantRefs: [...authorizedGrantRefs],
  };
}
