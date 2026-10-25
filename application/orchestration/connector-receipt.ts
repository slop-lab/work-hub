import {
  ConnectorOperationResultSchemas, validateSerializedOperationReceipt,
  type ActionContext, type OperationReceipt,
} from '../contracts/index.ts';

const effects: Readonly<Record<string, readonly string[]>> = {
  'execution.requestAllocation': ['allocation.ready'],
  'execution.attach': ['binding.attached'],
  'execution.cancelOperation': ['operation.cancellation_confirmed'],
  'execution.detachAttachment': ['binding.detached'],
  'execution.releaseAllocation': ['allocation.release_policy_applied'],
  'runtime.prepareRuntime': ['runtime.service_ready'],
  'runtime.openSession': ['session.opened'],
  'runtime.requestControl': ['runtime.control_granted'],
  'runtime.startAttempt': ['attempt.input_received'],
  'runtime.sendInstruction': ['instruction.accepted_by_runtime'],
  'runtime.deliverResponse': ['response.acknowledged'],
  'runtime.requestStop': ['attempt.termination_observed', 'attempt.stop_requested'],
  'runtime.detachSession': ['session.detached'],
};

export function validateConnectorReceipt<T>(input: {
  readonly receipt: OperationReceipt<T>; readonly context: ActionContext; readonly operationKind: string;
}): OperationReceipt<T> {
  const receipt = validateSerializedOperationReceipt(input.receipt);
  const descriptor = ConnectorOperationResultSchemas[input.operationKind];
  if (receipt.operationId !== input.context.operationId || receipt.operationKind !== input.operationKind ||
    descriptor === undefined || receipt.resultSchemaId !== descriptor.resultSchemaId) {
    throw new TypeError('Connector receipt does not identify the requested operation and result schema.');
  }
  if (receipt.status === 'confirmed' && !effects[input.operationKind]?.includes(receipt.evidence.effect)) {
    throw new TypeError('Connector evidence does not establish the requested effect.');
  }
  return input.receipt;
}
