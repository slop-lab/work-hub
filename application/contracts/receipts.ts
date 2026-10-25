import type { ZodType } from "zod";
import { AllocationDescriptorSchema, CancellationResultSchema, DetachedResultSchema, EnvironmentAttachmentSchema, ReleaseResultSchema } from "./execution.ts";
import { JsonValueSchema, SerializedOperationReceiptSchema, type JsonValue, type SerializedOperationReceipt } from "./common.ts";
import { InputReceiptSchema, ResponseDeliveryResultSchema, RuntimeBindingDescriptorSchema, RuntimeControlGrantSchema, RuntimeDetachedResultSchema, RuntimeRouteResultSchema, StopResultSchema } from "./runtime.ts";

export type OperationResultSchemaDescriptor = {
  readonly resultSchemaId: string;
  readonly schema: ZodType;
};

export const ConnectorOperationResultSchemas: Readonly<Record<string, OperationResultSchemaDescriptor>> = {
  "execution.requestAllocation": { resultSchemaId: "workhub.execution.allocation.v1", schema: AllocationDescriptorSchema },
  "execution.attach": { resultSchemaId: "workhub.execution.attachment.v1", schema: EnvironmentAttachmentSchema },
  "execution.cancelOperation": { resultSchemaId: "workhub.execution.cancellation.v1", schema: CancellationResultSchema },
  "execution.detachAttachment": { resultSchemaId: "workhub.execution.detached.v1", schema: DetachedResultSchema },
  "execution.releaseAllocation": { resultSchemaId: "workhub.execution.release.v1", schema: ReleaseResultSchema },
  "runtime.prepareRuntime": { resultSchemaId: "workhub.runtime.route.v1", schema: RuntimeRouteResultSchema },
  "runtime.openSession": { resultSchemaId: "workhub.runtime.binding.v1", schema: RuntimeBindingDescriptorSchema },
  "runtime.requestControl": { resultSchemaId: "workhub.runtime.control-grant.v1", schema: RuntimeControlGrantSchema },
  "runtime.startAttempt": { resultSchemaId: "workhub.runtime.input-receipt.v1", schema: InputReceiptSchema },
  "runtime.sendInstruction": { resultSchemaId: "workhub.runtime.input-receipt.v1", schema: InputReceiptSchema },
  "runtime.deliverResponse": { resultSchemaId: "workhub.runtime.response-receipt.v1", schema: ResponseDeliveryResultSchema },
  "runtime.requestStop": { resultSchemaId: "workhub.runtime.stop-result.v1", schema: StopResultSchema },
  "runtime.detachSession": { resultSchemaId: "workhub.runtime.detached.v1", schema: RuntimeDetachedResultSchema },
};

export class ConnectorReceiptDispatchError extends Error {
  readonly name = "ConnectorReceiptDispatchError";
  readonly code: "operation_kind_unknown" | "result_schema_mismatch";
  readonly operationKind: string;
  readonly resultSchemaId: string;
  constructor(code: "operation_kind_unknown" | "result_schema_mismatch", operationKind: string, resultSchemaId: string) {
    super(code === "operation_kind_unknown" ? `No result schema is registered for ${operationKind}.` : `Result schema ${resultSchemaId} does not match ${operationKind}.`);
    this.code = code;
    this.operationKind = operationKind;
    this.resultSchemaId = resultSchemaId;
  }
}

export function validateSerializedOperationReceipt(value: unknown): SerializedOperationReceipt {
  const receipt = SerializedOperationReceiptSchema.parse(value);
  if (receipt.status !== "confirmed") return receipt;
  const descriptor = ConnectorOperationResultSchemas[receipt.operationKind];
  if (descriptor === undefined) throw new ConnectorReceiptDispatchError("operation_kind_unknown", receipt.operationKind, receipt.resultSchemaId);
  if (descriptor.resultSchemaId !== receipt.resultSchemaId) throw new ConnectorReceiptDispatchError("result_schema_mismatch", receipt.operationKind, receipt.resultSchemaId);
  const result: JsonValue = JsonValueSchema.parse(descriptor.schema.parse(receipt.result));
  return { ...receipt, result };
}
