import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from '@opencode-ai/plugin';
import { JsonValueSchema, type JsonValue } from '../contracts/common.ts';
import { HubError } from '../domain/errors.ts';
import { RecipientOperationSchema, RecipientResultSchema, type RecipientOperation } from './recipient-operations.ts';

export type RecipientInvoker = (sessionId: string, operation: RecipientOperation, signal: AbortSignal) => Promise<JsonValue>;

const invokeDim: RecipientInvoker = async (sessionId, operation, signal) => {
  try {
    const { kind, ...payload } = operation;
    const result = await promisify(execFile)('dim-workspace', ['plugin', 'work-hub', kind,
      JSON.stringify({ nativeSessionId: sessionId, ...payload })], {
      timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal,
      env: { HOME: process.env['HOME'], PATH: process.env['PATH'] },
    });
    return JsonValueSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof Error) throw new HubError({ code: 'recipient_helper_unavailable', category: 'unavailable',
      message: 'The selected Work Hub recipient integration was unavailable. Discover DIM workspace capabilities or ask its operator to install the reviewed integration.',
      retry: operation.kind === 'assignment' ? 'read_only_retry' : 'reconcile_first' });
    throw error;
  }
};

export function createWorkHubTools(invoke: RecipientInvoker = invokeDim) {
  return {
    workhub_assignment: tool({ description: 'Read the exact Work Hub assignment for this native session, including source, context, requested validation and delivery binding. Does not start work.',
      args: {}, async execute(_args, context) {
        return JSON.stringify(await invoke(context.sessionID, { kind: 'assignment' }, context.abort));
      } }),
    workhub_ack: tool({ description: 'Acknowledge receipt of this session’s exact Work Hub delivery digest. Does not claim verification success or human acceptance.',
      args: { deliveryDigest: tool.schema.string().min(1) }, async execute(args, context) {
        return JSON.stringify(await invoke(context.sessionID, RecipientOperationSchema.parse({ kind: 'ack', ...args }), context.abort));
      } }),
    workhub_result: tool({ description: 'Report a checkpoint or final source/context-bound result with criterion evidence, actual tested commit, artifacts and limitations. Use a stable submission key; final prose is not human acceptance.',
      args: {
        submissionKey: tool.schema.string().min(1).max(200), kind: tool.schema.enum(['checkpoint', 'final']),
        sourceCommit: tool.schema.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        contextDigest: tool.schema.string().min(1), outcome: tool.schema.enum(['passed', 'failed', 'partial', 'blocked', 'unspecified']),
        summary: tool.schema.string().min(1).max(32_768), limitations: tool.schema.array(tool.schema.string().max(8192)).max(50),
        referenceIds: tool.schema.array(tool.schema.string().min(1)).max(100),
        artifacts: tool.schema.array(tool.schema.object({ repositoryId: tool.schema.string().min(1),
          sourceCommit: tool.schema.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), path: tool.schema.string().min(1).max(4096),
          digest: tool.schema.string().optional() })).max(100),
        criterionEvidence: tool.schema.array(tool.schema.object({ criterionId: tool.schema.string().min(1),
          status: tool.schema.enum(['satisfied', 'not_satisfied', 'not_verified']),
          detail: tool.schema.string().min(1).max(8192), referenceIds: tool.schema.array(tool.schema.string().min(1)).max(100) })).max(100),
        evidence: tool.schema.array(tool.schema.object({ origin: tool.schema.literal('agent_claim'),
          detail: tool.schema.string().min(1).max(8192) })).max(100),
      }, async execute(args, context) {
        return JSON.stringify(await invoke(context.sessionID, { kind: 'result', result: RecipientResultSchema.parse(args) }, context.abort));
      } }),
  };
}
