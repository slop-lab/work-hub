import { join } from 'node:path';
import { z } from 'zod';
import type { JsonValue } from '../contracts/common.ts';
import { forbidden, HubError, unsupported } from '../domain/errors.ts';
import { readPrivateConfiguration } from '../connectors/private-config.ts';
import { RecipientOperationSchema, type RecipientOperation } from './recipient-operations.ts';
import { RecipientHttp } from './recipient-http.ts';
import { JsonObjectSchema } from '../contracts/common.ts';
import { digest } from '../persistence/codec.ts';

const origin = z.url().refine((value) => {
  const parsed = new URL(value);
  return parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password &&
    (parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
});
export const RecipientRegistrationSchema = z.strictObject({
  installationId: z.string().min(1), hostId: z.string().min(1), workHubWorkspaceId: z.string().min(1),
  targetWorkspaceId: z.string().uuid(),
  incarnation: z.string().min(1), port: z.number().int().min(1).max(65535), origin,
  authorization: z.string().min(1), expiresAt: z.iso.datetime().optional(),
});
const configuration = z.strictObject({ recipients: z.array(RecipientRegistrationSchema).max(100) }).superRefine((value, context) => {
  if (new Set(value.recipients.map((item) => item.targetWorkspaceId)).size !== value.recipients.length) {
    context.addIssue({ code: 'custom', message: 'Select one recipient installation per workspace.' });
  }
});
export type RecipientRegistration = z.infer<typeof RecipientRegistrationSchema>;
type WorkspaceIdentity = { readonly id: string; readonly phase: string };
type RuntimeTarget = { readonly containers: readonly string[]; readonly port: number; readonly protocol: 'http' };
type HostContext<Workspace> = { readonly stateRoot: string; readonly signal: AbortSignal;
  readonly runtime?: { resolveTarget?(workspace: Workspace, target: RuntimeTarget): Promise<{ readonly fingerprint: string }> } };
export type RecipientProxy = (registration: RecipientRegistration, nativeSessionId: string, operation: RecipientOperation) => Promise<JsonValue>;
type ConfigurationReader = (stateRoot: string) => readonly RecipientRegistration[];
const assignmentSchema = z.strictObject({
  workHubWorkspaceId: z.string(), targetWorkspaceId: z.string().uuid(), hostId: z.string(), projectId: z.string(),
  taskId: z.string(), sessionId: z.string(), sessionRevision: z.number().int().positive(), attemptId: z.string(),
  bindingGeneration: z.number().int().positive(), installationId: z.string(), incarnation: z.string(),
  nativeSessionDigest: z.string(), deliveryDigest: z.string(), profileId: z.string(), profileRevision: z.number().int().positive(),
  inputSnapshot: JsonObjectSchema,
});
const exchangeSchema = z.strictObject({ token: z.string().min(1), expiresAt: z.iso.datetime(), assignment: assignmentSchema });

export function createWorkHubRecipientProxy(): RecipientProxy {
  return async (registration, nativeSessionId, operation) => {
    const http = new RecipientHttp(registration.origin);
    const exchange = exchangeSchema.parse(await http.request({ method: 'POST', path: '/api/v1/recipient/exchange',
      authorization: `Integration ${registration.authorization}`, body: { nativeSessionId } }));
    if (exchange.assignment.workHubWorkspaceId !== registration.workHubWorkspaceId ||
      exchange.assignment.targetWorkspaceId !== registration.targetWorkspaceId ||
      exchange.assignment.hostId !== registration.hostId || exchange.assignment.installationId !== registration.installationId ||
      exchange.assignment.incarnation !== registration.incarnation) throw new HubError({ code: 'recipient_assignment_identity',
        category: 'identity_mismatch', message: 'Work Hub returned an assignment for another configured recipient identity.', retry: 'never' });
    switch (operation.kind) {
      case 'assignment': return exchange.assignment;
      case 'ack':
        if (operation.deliveryDigest !== exchange.assignment.deliveryDigest) throw new HubError({ code: 'recipient_delivery_changed',
          category: 'conflict', message: 'The selected delivery digest is no longer current.', retry: 'read_only_retry' });
        return http.request({ method: 'POST', path: '/api/v1/bridge/attempt-delivery/ack',
          authorization: `Bearer ${exchange.token}`, body: { deliveryDigest: operation.deliveryDigest } });
      case 'result': {
        const inputDigest = z.string().min(1).parse(exchange.assignment.inputSnapshot['digest']);
        const artifacts = operation.result.artifacts.map((artifact) => ({
          repositoryId: artifact.repositoryId, sourceCommit: artifact.sourceCommit, path: artifact.path,
          ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
        }));
        return http.request({ method: 'POST', path: '/api/v1/bridge/commands',
          authorization: `Bearer ${exchange.token}`, body: JsonObjectSchema.parse({ commandId: `recipient-result:${digest({ attemptId: exchange.assignment.attemptId,
            submissionKey: operation.result.submissionKey })}`, type: 'result.submit',
            target: { kind: 'attempt', id: exchange.assignment.attemptId }, payload: {
            submissionKey: operation.result.submissionKey, outcome: operation.result.outcome,
            kind: operation.result.kind,
              inputDigest, actualCommit: operation.result.sourceCommit,
              actualContextDigest: operation.result.contextDigest, summary: operation.result.summary,
              limitations: operation.result.limitations, referenceIds: operation.result.referenceIds,
            artifacts, evidence: operation.result.evidence, criterionEvidence: operation.result.criterionEvidence,
            } }) });
      }
      default: return operation satisfies never;
    }
  };
}

async function attest<Workspace extends WorkspaceIdentity>(workspace: Workspace, registration: RecipientRegistration, context: HostContext<Workspace>): Promise<void> {
  if (workspace.phase !== 'running') throw unsupported('recipient_target_not_running', 'The assigned workspace is not running.');
  const runtime = context.runtime;
  if (runtime?.resolveTarget === undefined) throw unsupported('recipient_identity_unavailable', 'This runtime cannot attest its recipient incarnation.');
  let timer: NodeJS.Timeout | undefined;
  let rejectCancellation: (() => void) | undefined;
  const unavailable = () => new HubError({ code: 'recipient_attestation_unavailable', category: 'unavailable',
    message: 'Recipient runtime identity could not be attested within its bounded observation lifetime.', retry: 'read_only_retry' });
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = () => reject(unavailable());
    timer = setTimeout(rejectCancellation, 5000);
    context.signal.addEventListener('abort', rejectCancellation, { once: true });
    if (context.signal.aborted) rejectCancellation();
  });
  try {
    const current = await Promise.race([runtime.resolveTarget(workspace, { containers: [], port: registration.port, protocol: 'http' }), cancellation]);
    if (current.fingerprint !== registration.incarnation) throw new HubError({ code: 'recipient_incarnation_changed', category: 'identity_mismatch',
      message: 'The workspace runtime incarnation changed; its old recipient capability is no longer valid.', retry: 'manual_action' });
  } finally {
    clearTimeout(timer);
    if (rejectCancellation !== undefined) context.signal.removeEventListener('abort', rejectCancellation);
  }
}

function readRecipients(stateRoot: string): readonly RecipientRegistration[] {
  const path = process.env['WORK_HUB_RECIPIENT_CONFIG'] ?? join(stateRoot, 'plugins/work-hub/recipients.json');
  try { return configuration.parse(readPrivateConfiguration(path)).recipients; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export function createDimRecipientPlugin(proxy: RecipientProxy, read: ConfigurationReader = readRecipients) {
  const registration = (workspace: WorkspaceIdentity, stateRoot: string): RecipientRegistration => {
    const selected = read(stateRoot).find((item) => item.targetWorkspaceId === workspace.id);
    if (selected === undefined) throw unsupported('recipient_unconfigured', 'No Work Hub recipient integration is selected for this workspace.');
    if (selected.expiresAt !== undefined && Date.parse(selected.expiresAt) <= Date.now()) throw forbidden('The Work Hub recipient integration expired.');
    return selected;
  };
  const inspect = async <Workspace extends WorkspaceIdentity>(workspace: Workspace, context: HostContext<Workspace>) => {
    try {
      const selected = registration(workspace, context.stateRoot);
      await attest(workspace, selected, context);
      return { state: 'ready' as const };
    } catch (error) {
      if (error instanceof Error) return { state: 'unconfigured' as const,
        message: 'The selected Work Hub recipient integration is unavailable or its current runtime identity is not authorized.' };
      throw error;
    }
  };
  const operation = (kind: RecipientOperation['kind'], description: string) => ({ name: kind, description,
    async handle<Workspace extends WorkspaceIdentity>(input: unknown, workspace: Workspace, context: HostContext<Workspace>) {
      const { nativeSessionId, ...payload } = z.object({ nativeSessionId: z.string().startsWith('ses').max(200) }).catchall(z.unknown()).parse(input);
      const request = RecipientOperationSchema.parse({ ...payload, kind });
      const selected = registration(workspace, context.stateRoot);
      await attest(workspace, selected, context);
      return proxy(selected, nativeSessionId, request);
    } });
  return {
    name: 'work-hub',
    guest: {
      description: 'Scoped Work Hub assignment, receipt acknowledgment and exact-source result reporting. No task scheduler or remote execution.',
      operations: [operation('assignment', 'Read the current assignment for the selected native session.'),
        operation('ack', 'Acknowledge the exact assigned input without claiming completion.'),
        operation('result', 'Report an exact-source result; human acceptance remains separate.')],
      inspect,
    },
    async workspaceCapabilities<Workspace extends WorkspaceIdentity>(workspace: Workspace, context: HostContext<Workspace>) {
      const current = await inspect(workspace, context);
      return (['assignment', 'ack', 'result'] as const).map((name) => ({ name: `workhub-${name}`,
        description: `Work Hub recipient ${name}`, state: current.state === 'ready' ? 'available' as const : 'unavailable' as const,
        access: { kind: 'guest-operation' as const, operation: name } }));
    },
  };
}
