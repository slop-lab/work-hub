import type { Capability, ConnectorManifest, RuntimeCapabilities } from '../../contracts/index.ts';

const supported: Capability = { support: 'supported', implementation: 'connector', limitations: [] };
const nativeView: Capability = { support: 'unsupported', limitations: ['Use authenticated Claude Code for this interaction.'] };
const noEmptyCreate: Capability = { support: 'unsupported', limitations: [
  'The stable Agent SDK has no empty-session constructor. A session begins only with a real user prompt.',
] };

export const claudeCapabilities: RuntimeCapabilities = {
  servicePreparation: nativeView, controlTransfer: nativeView, createSession: noEmptyCreate, attachSession: supported,
  structuredInput: supported, structuredOutput: nativeView, nativeQuestions: nativeView, requestBridge: nativeView,
  nativeApprovals: nativeView, continueNativeSession: supported, outputReplay: supported,
  stableNativeIdentity: supported, resultReporting: supported, activeInputModes: ['runtime_queued'], stopModes: [],
  stopObservation: 'request_only', surfaces: ['transcript', 'native_view'],
  configurationSchemaId: 'workhub.claude-code.selection.v1',
};

export const claudeManifest: ConnectorManifest = {
  id: 'workhub.claude-code', kind: 'agent_runtime', implementationVersion: '0.2.0', contractMajor: 1,
  configurationSchemaId: claudeCapabilities.configurationSchemaId, requiredSecretPurposes: [],
  requiredPermissions: ['session.control'],
  operationSafety: Object.fromEntries(['openSession', 'startAttempt', 'sendInstruction', 'detachSession'].map((method) =>
    [method, { deduplicatesByClientOperationId: false, lookupByClientOperationId: true, replayAfterUnknown: 'never' }])),
  extensions: { simulated: false, sdkPackage: '@anthropic-ai/claude-agent-sdk', sdkVersion: '0.3.311',
     emptySessionCreation: false, nativePromptIdempotency: false,
     approvals: 'No broad native tool approval is granted by this connector.',
     inputConfirmation: 'A confirmed input receipt waits for the exact echoed user UUID; unknown delivery is never resent.',
     lifecycleFrames: 'Checkpoint, final, tool, subagent, retry, rate-limit, startup and terminal metadata are mapped from exact Agent SDK fields.',
     activityCoverage: 'Parent completion is withheld when observed subagent work is active or registry coverage is partial.',
     liveValidation: 'Authenticated Claude Code execution remains an explicit operator validation gap until scoped credentials are supplied.',
     stop: 'Request-stop remains unsupported because aborting an accepted SDK turn is not an exact safe stop contract.' },
};
