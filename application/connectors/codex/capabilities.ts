import type { Capability, ConnectorManifest, RuntimeCapabilities } from '../../contracts/index.ts';

const supported: Capability = { support: 'supported', implementation: 'connector', limitations: [] };
const unsupported: Capability = { support: 'unsupported', limitations: ['Use an authenticated native Codex client for this capability.'] };
const nativeInteraction: Capability = { support: 'unsupported', limitations: [
  'Use an authenticated native Codex client. Multi-question, secret, permission, and approval interactions are not bridged.',
] };
const supportedQuestions: Capability = { support: 'supported', implementation: 'connector', limitations: [
  'Only one non-secret text question or fixed-choice question is bridged.',
] };
export const codexCapabilities: RuntimeCapabilities = {
  servicePreparation: unsupported, controlTransfer: unsupported, createSession: supported, attachSession: supported,
  structuredInput: supported, structuredOutput: unsupported, nativeQuestions: supportedQuestions, requestBridge: unsupported,
  nativeApprovals: nativeInteraction, continueNativeSession: supported, outputReplay: supported, stableNativeIdentity: supported,
  resultReporting: supported, activeInputModes: ['runtime_queued'], stopModes: ['interrupt'], stopObservation: 'request_only',
  surfaces: ['transcript', 'native_view'], configurationSchemaId: 'workhub.codex.selection.v1',
};
export const codexManifest: ConnectorManifest = {
  id: 'workhub.codex', kind: 'agent_runtime', implementationVersion: '0.1.0', contractMajor: 1,
  configurationSchemaId: codexCapabilities.configurationSchemaId,
  requiredSecretPurposes: ['codex-runtime-credential'], requiredPermissions: ['session.control'],
  operationSafety: Object.fromEntries(['openSession', 'startAttempt', 'sendInstruction', 'deliverResponse', 'requestStop', 'detachSession']
    .map((method) => [method, { deduplicatesByClientOperationId: false, lookupByClientOperationId: true, replayAfterUnknown: 'never' }])),
  extensions: { simulated: false, protocol: 'Codex app-server JSON-RPC v2', nativePromptIdempotency: false,
    limitations: 'Only one simple non-secret question is relayed; approvals remain native-only. Child activity requires native reconciliation. Unknown effects require exact clientUserMessageId reconciliation and are never resent.' },
};
