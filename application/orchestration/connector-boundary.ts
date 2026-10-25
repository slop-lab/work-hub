import type { AgentRuntimeConnector, ExecutionConnector } from '../contracts/index.ts';
import { z } from 'zod';
import { AllocationRequestSchema, AllocationReleaseSchema, AttachmentRequestSchema, BindingObservationSchema, DetachAttachmentInputSchema, EnvironmentAttachmentSchema, EnvironmentProbeSchema, ExistingEnvironmentRegistrationSchema, InstructionInputSchema, OpenSessionInputSchema, OutputPageSchema, RequestControlInputSchema, ResponseDeliverySchema, RuntimePreparationSchema, RuntimeReadinessSchema, RuntimeRouteSchema, RuntimeSessionObservationSchema, RuntimeTargetSchema, ReadOutputInputSchema, SubscribeInputSchema, RuntimeEventSchema, AttemptStartSchema, StopInputSchema, OperationLookupSchema } from '../contracts/index.ts';
import { validateConnectorReceipt } from './connector-receipt.ts';
import { validateConnectorObservation } from './connector-observation.ts';
import { digest } from '../persistence/codec.ts';

export function executionBoundary(connector: ExecutionConnector): ExecutionConnector {
  return {
    describe: () => connector.describe(),
    probeExisting: async (context, registration) => { ExistingEnvironmentRegistrationSchema.parse(registration); return validateConnectorObservation({ context,
      schema: EnvironmentProbeSchema, observation: await connector.probeExisting(context, registration) }); },
    inspectBinding: async (context, attachment) => { EnvironmentAttachmentSchema.parse(attachment); return validateConnectorObservation({ context,
      schema: BindingObservationSchema, observation: await connector.inspectBinding(context, attachment) }); },
    lookupOperation: async (context, id) => { z.string().min(1).parse(id); const lookup = await connector.lookupOperation(context, id); OperationLookupSchema.parse(lookup); if (lookup.kind === 'found' && lookup.receipt.operationId !== id) throw new TypeError('Lookup returned another operation.'); return lookup; },
    requestAllocation: async (context, input) => { AllocationRequestSchema.parse(input); return validateConnectorReceipt({ context,
      operationKind: 'execution.requestAllocation', receipt: await connector.requestAllocation(context, input) }); },
    attach: async (context, input) => {
      AttachmentRequestSchema.parse(input);
      const receipt = validateConnectorReceipt({ context, operationKind: 'execution.attach', receipt: await connector.attach(context, input) });
      if (receipt.status === 'confirmed') {
        const result = receipt.result;
        if (result.hubBindingId !== input.hubBindingId || result.hubBindingGeneration !== input.hubBindingGeneration ||
          result.origin !== (input.target.kind === 'allocation' ? 'allocated' : 'registered_existing') ||
          result.attachmentRef.installationId !== context.installationId ||
          result.routes.some((route) => route.ownerInstallationId !== context.installationId)) {
          throw new TypeError('Attachment receipt does not identify the requested binding and provider.');
        }
      }
      return receipt;
    },
    cancelOperation: async (context, id) => { z.string().min(1).parse(id); return validateConnectorReceipt({ context,
      operationKind: 'execution.cancelOperation', receipt: await connector.cancelOperation(context, id) }); },
    detachAttachment: async (context, input) => { DetachAttachmentInputSchema.parse(input); return validateConnectorReceipt({ context,
      operationKind: 'execution.detachAttachment', receipt: await connector.detachAttachment(context, input) }); },
    releaseAllocation: async (context, input) => { AllocationReleaseSchema.parse(input); return validateConnectorReceipt({ context,
      operationKind: 'execution.releaseAllocation', receipt: await connector.releaseAllocation(context, input) }); },
  };
}

export function runtimeBoundary(connector: AgentRuntimeConnector): AgentRuntimeConnector {
  const prepareRuntime = connector.prepareRuntime?.bind(connector);
  const subscribe = connector.subscribe?.bind(connector);
  return {
    describe: () => connector.describe(),
    probe: async (context, route) => { RuntimeRouteSchema.parse(route); return validateConnectorObservation({ context,
      schema: RuntimeReadinessSchema, observation: await connector.probe(context, route) }); },
    inspectSession: async (context, target) => { RuntimeTargetSchema.parse(target); return validateConnectorObservation({ context,
      schema: RuntimeSessionObservationSchema, observation: await connector.inspectSession(context, target) }); },
    readOutput: async (context, input) => {
      ReadOutputInputSchema.parse(input);
      const output = await connector.readOutput(context, input);
      OutputPageSchema.parse(output);
      return output;
    },
    lookupOperation: async (context, id) => { z.string().min(1).parse(id); const lookup = await connector.lookupOperation(context, id); OperationLookupSchema.parse(lookup); if (lookup.kind === 'found' && lookup.receipt.operationId !== id) throw new TypeError('Lookup returned another operation.'); return lookup; },
    ...(subscribe === undefined ? {} : { subscribe: async function* (...args: Parameters<NonNullable<AgentRuntimeConnector['subscribe']>>) {
      SubscribeInputSchema.parse(args[1]);
      for await (const event of subscribe(...args)) { RuntimeEventSchema.parse(event); yield event; }
    } }),
    ...(prepareRuntime === undefined ? {} : { prepareRuntime: async (...args: Parameters<NonNullable<AgentRuntimeConnector['prepareRuntime']>>) => { RuntimePreparationSchema.parse(args[1]); return validateConnectorReceipt({ context: args[0],
      operationKind: 'runtime.prepareRuntime', receipt: await prepareRuntime(...args) }); } }),
    openSession: async (context, input) => {
      OpenSessionInputSchema.parse(input);
      const receipt = validateConnectorReceipt({ context, operationKind: 'runtime.openSession', receipt: await connector.openSession(context, input) });
      if (receipt.status === 'confirmed') {
        const result = receipt.result;
        const expectedOrigin = input.mode === 'create' ? 'created' : input.sessionLaunchOwner === 'execution_provider' ? 'provider_precreated' : 'attached_existing';
        if (result.nativeSession.installationId !== context.installationId || result.origin !== expectedOrigin ||
          digest(result.route) !== digest(input.route.route) ||
          (input.mode === 'attach' && digest(result.nativeSession) !== digest(input.nativeSession)) ||
          (input.requestedControl === 'observe' && (result.controlGrant.mode !== 'observe' || result.controlGrant.allowedActions.length > 0))) {
          throw new TypeError('Runtime receipt does not preserve the selected native target, route, origin and control scope.');
        }
      }
      return receipt;
    },
    requestControl: async (context, input) => { RequestControlInputSchema.parse(input); return validateConnectorReceipt({ context,
      operationKind: 'runtime.requestControl', receipt: await connector.requestControl(context, input) }); },
    startAttempt: async (context, input) => { AttemptStartSchema.parse(input); return validateConnectorReceipt({ context,
      operationKind: 'runtime.startAttempt', receipt: await connector.startAttempt(context, input) }); },
    sendInstruction: async (context, input) => { InstructionInputSchema.parse(input); return validateConnectorReceipt({ context,
      operationKind: 'runtime.sendInstruction', receipt: await connector.sendInstruction(context, input) }); },
    deliverResponse: async (context, input) => {
      ResponseDeliverySchema.parse(input);
      const receipt = validateConnectorReceipt({ context, operationKind: 'runtime.deliverResponse', receipt: await connector.deliverResponse(context, input) });
      if (receipt.status === 'confirmed' && receipt.result.responseId !== input.responseId) {
        throw new TypeError('Delivery receipt acknowledges a different response.');
      }
      return receipt;
    },
    requestStop: async (context, input) => { StopInputSchema.parse(input); return validateConnectorReceipt({ context,
      operationKind: 'runtime.requestStop', receipt: await connector.requestStop(context, input) }); },
    detachSession: async (context, target) => { RuntimeTargetSchema.parse(target); return validateConnectorReceipt({ context,
      operationKind: 'runtime.detachSession', receipt: await connector.detachSession(context, target) }); },
  };
}
