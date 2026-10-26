import type { Capability, ConnectorManifest, RuntimeCapabilities } from '../../contracts/index.ts';

const supported: Capability = { support: 'supported', implementation: 'connector', limitations: [] };
const unsupported: Capability = { support: 'unsupported', limitations: ['Use the authenticated native OpenCode view for unsupported interaction.'] };
export const openCodeCapabilities: RuntimeCapabilities = {
  servicePreparation: unsupported, controlTransfer: unsupported,
  createSession: supported, attachSession: supported, structuredInput: supported,
  structuredOutput: unsupported, nativeQuestions: supported, requestBridge: unsupported,
  nativeApprovals: unsupported, continueNativeSession: supported, outputReplay: supported,
  stableNativeIdentity: supported, resultReporting: supported,
  activeInputModes: ['runtime_queued'], stopModes: ['interrupt'], stopObservation: 'request_only',
  surfaces: ['transcript', 'native_view'], configurationSchemaId: 'workhub.opencode.selection.v1',
};
export const openCodeManifest: ConnectorManifest = {
  id: 'workhub.opencode', kind: 'agent_runtime', implementationVersion: '0.1.0', contractMajor: 1,
  configurationSchemaId: openCodeCapabilities.configurationSchemaId,
  requiredSecretPurposes: ['opencode-scoped-http'], requiredPermissions: ['session.control'],
  operationSafety: Object.fromEntries(['openSession', 'startAttempt', 'sendInstruction', 'deliverResponse', 'requestStop', 'detachSession']
    .map((method) => [method, { deduplicatesByClientOperationId: false, lookupByClientOperationId: true, replayAfterUnknown: 'never' }])),
  extensions: { simulated: false, nativePromptIdempotency: false,
    history: 'Bounded history and exact client message ID lookup; HTTP 204 is not execution evidence.',
    questions: 'Only one free-text or single-choice question is mapped. Multiple questions, multi-select and permissions require native view.' },
};
