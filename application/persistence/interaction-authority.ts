import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { RequestValiditySchema, ResourceIdentitySchema, RuntimeBindingDescriptorSchema } from '../contracts/index.ts';
import type { RequestView } from '../domain/model.ts';
import { digest, parseJson, type Clock } from './codec.ts';
import { toRequest as toRequestRecord } from './request-codec.ts';

type RequestScope = Pick<RequestView, 'workspaceId' | 'projectId' | 'taskId' | 'sessionId' | 'attemptId' | 'bindingGeneration' | 'kind' | 'validity' | 'responseRoute'> & { readonly recipient?: Readonly<Record<string, unknown>> };

export type RequestContext = {
  readonly workspaceId: string; readonly projectId: string; readonly taskId?: string;
  readonly sessionId?: string; readonly attemptId?: string; readonly bindingGeneration?: number;
};
export class InteractionAuthority {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  constructor(database: DatabaseSync, clock: Clock) { this.database = database; this.clock = clock; }
  attemptScope(workspaceId: string, attemptId: string) {
    return z.object({ taskId: z.string(), sessionId: z.string() }).parse(this.database.prepare('SELECT task_id AS taskId,session_id AS sessionId FROM attempts WHERE workspace_id=? AND id=?').get(workspaceId, attemptId));
  }
  validateRequestContext(input: RequestContext): boolean {
    if (!this.database.prepare('SELECT id FROM projects WHERE workspace_id=? AND id=? AND archived_at IS NULL').get(input.workspaceId, input.projectId)) return false;
    if (input.taskId && !this.database.prepare('SELECT id FROM tasks WHERE workspace_id=? AND id=? AND project_id=?').get(input.workspaceId, input.taskId, input.projectId)) return false;
    if (input.sessionId && !this.database.prepare('SELECT id FROM sessions WHERE workspace_id=? AND id=? AND project_id=? AND (? IS NULL OR task_id=?) AND (? IS NULL OR binding_generation=?)').get(input.workspaceId, input.sessionId, input.projectId, input.taskId ?? null, input.taskId ?? null, input.bindingGeneration ?? null, input.bindingGeneration ?? null)) return false;
    if (input.attemptId && !this.database.prepare(`SELECT a.id FROM attempts a JOIN sessions s ON s.id=a.session_id WHERE a.workspace_id=? AND a.id=? AND s.project_id=? AND (? IS NULL OR a.task_id=?) AND (? IS NULL OR a.session_id=?)`).get(input.workspaceId, input.attemptId, input.projectId, input.taskId ?? null, input.taskId ?? null, input.sessionId ?? null, input.sessionId ?? null)) return false;
    return true;
  }
  validityMatchesContext(request: RequestScope): boolean {
    const parsed = RequestValiditySchema.safeParse(request.validity);
    if (!parsed.success) return false;
    const validity = parsed.data;
    switch (validity.kind) {
      case 'project': return validity.projectId === request.projectId && request.responseRoute === 'none' && request.kind !== 'approval';
      case 'task': return validity.taskId === request.taskId && request.responseRoute === 'none' && request.kind !== 'approval';
      case 'attempt': return validity.target.hubSessionId === request.sessionId && validity.target.hubAttemptId === request.attemptId && validity.target.bindingGeneration === request.bindingGeneration;
      default: return assertNever(validity);
    }
  }
  targetCurrent(request: RequestScope): boolean {
    if (!this.validityMatchesContext(request)) return false;
    if (request.recipient?.['kind'] === 'agent_session' && !this.database.prepare(`SELECT a.id FROM attempts a
      JOIN sessions s ON s.id=a.session_id AND s.workspace_id=a.workspace_id
      WHERE a.workspace_id=? AND a.id=? AND a.session_id=? AND a.unresolved=1
        AND s.lifecycle='open' AND s.active_attempt_id=a.id AND s.binding_generation=?`)
      .get(request.workspaceId, request.attemptId ?? '', request.sessionId ?? '', request.bindingGeneration ?? -1)) return false;
    const validity = RequestValiditySchema.parse(request.validity);
    if (validity.expiresAt && Date.parse(validity.expiresAt) <= this.clock.now().getTime()) return false;
    if (validity.kind !== 'attempt') return true;
    const raw = this.database.prepare(`SELECT a.profile_revision AS profileRevision,
      b.descriptor_json AS descriptorJson,s.binding_generation AS generation
      FROM attempts a JOIN sessions s ON s.id=a.session_id
      JOIN runtime_bindings b ON b.session_id=s.id
      WHERE a.workspace_id=? AND a.id=? AND a.session_id=? AND a.task_id=?
        AND a.unresolved=1 AND s.lifecycle='open' AND s.binding_generation=?
        AND b.generation=s.binding_generation`).get(
      request.workspaceId, validity.target.hubAttemptId, validity.target.hubSessionId,
      request.taskId ?? '', validity.target.bindingGeneration,
    );
    if (!raw) return false;
    const row = z.object({ profileRevision: z.number(), descriptorJson: z.string(), generation: z.number() }).parse(raw);
    const descriptor = RuntimeBindingDescriptorSchema.parse(parseJson(row.descriptorJson));
    if (digest(descriptor.nativeSession) !== digest(validity.target.nativeSession) || descriptor.controlGrant.id !== validity.target.controlGrantRef) return false;
    if (descriptor.controlGrant.expiresAt && Date.parse(descriptor.controlGrant.expiresAt) <= this.clock.now().getTime()) return false;
    if (request.responseRoute !== 'none' && (descriptor.controlGrant.mode !== 'control' || !descriptor.controlGrant.allowedActions.includes('deliver_response'))) return false;
    if (request.responseRoute === 'native' && request.kind === 'approval' && descriptor.capabilities.nativeApprovals.support !== 'supported') return false;
    if (request.responseRoute === 'native' && request.kind === 'question' && descriptor.capabilities.nativeQuestions.support !== 'supported') return false;
    if (request.responseRoute === 'bridge' && descriptor.capabilities.requestBridge.support !== 'supported') return false;
    if (request.responseRoute !== 'none' && !this.database.prepare('SELECT id FROM connector_installations WHERE workspace_id=? AND id=? AND enabled=1 AND contract_major=1').get(request.workspaceId, descriptor.nativeSession.installationId)) return false;
    if (request.kind === 'approval' && (validity.actionDigest === undefined || validity.policyRevision !== String(row.profileRevision))) return false;
    const bindings = this.database.prepare(`SELECT identity_json AS identityJson,observation_json AS observationJson,use_grant_json AS useGrantJson,state FROM environment_bindings WHERE workspace_id=? AND session_id=? AND state NOT IN ('detached','released')`).all(request.workspaceId, request.sessionId ?? '').map((value) => z.object({ identityJson: z.string().nullable(), observationJson: z.string().nullable(), useGrantJson: z.string().nullable(), state: z.string() }).parse(value));
    for (const binding of bindings) {
      if (binding.state !== 'attached' || binding.identityJson === null) return false;
      if (binding.useGrantJson) {
        const useGrant = z.object({ expiresAt: z.string().optional() }).parse(parseJson(binding.useGrantJson));
        if (useGrant.expiresAt && Date.parse(useGrant.expiresAt) <= this.clock.now().getTime()) return false;
      }
      if (binding.observationJson) {
        const observation = z.object({ identity: ResourceIdentitySchema, state: z.string(), attachmentValid: z.union([z.boolean(), z.literal('unknown')]), grantValid: z.union([z.boolean(), z.literal('unknown')]) }).safeParse(parseJson(binding.observationJson));
        if (!observation.success || observation.data.state !== 'running' || observation.data.attachmentValid !== true || observation.data.grantValid !== true || digest(observation.data.identity) !== digest(ResourceIdentitySchema.parse(parseJson(binding.identityJson)))) return false;
      }
    }
    const expected = validity.environmentIdentities ?? [];
    if (request.kind === 'approval' && expected.length !== bindings.length) return false;
    return expected.every((identity) => bindings.some((binding) => binding.identityJson !== null && digest(identity) === digest(ResourceIdentitySchema.parse(parseJson(binding.identityJson)))));
  }
  deliveryAllowed(workspaceId: string, requestId: string, responseId: string): boolean {
    const raw = this.database.prepare('SELECT q.* FROM requests q JOIN responses r ON r.request_id=q.id WHERE q.workspace_id=? AND q.id=? AND r.id=? AND q.revision=r.request_revision AND q.status=\'answered\'').get(workspaceId, requestId, responseId);
    if (!raw) return false;
    return this.targetCurrent(toRequestRecord(raw));
  }
  validateSelectedResponses(workspaceId: string, taskId: string, responseIds: readonly string[]): boolean {
    const statement = this.database.prepare(`SELECT 1 FROM responses p JOIN requests q ON q.id=p.request_id JOIN tasks t ON t.id=? AND t.workspace_id=p.workspace_id WHERE p.workspace_id=? AND p.id=? AND q.project_id=t.project_id AND (q.task_id IS NULL OR q.task_id=t.id) AND q.status='answered'`);
    return responseIds.every((id) => statement.get(taskId, workspaceId, id) !== undefined);
  }
  recipientEligible(input: { readonly workspaceId: string; readonly projectId: string; readonly taskId?: string; readonly recipient: Readonly<Record<string, unknown>> }): boolean {
    switch (input.recipient['kind']) {
      case 'project_members': return input.recipient['projectId'] === input.projectId;
      case 'agent_session': return typeof input.recipient['sessionId'] === 'string' && this.database.prepare('SELECT id FROM sessions WHERE workspace_id=? AND project_id=? AND id=? AND lifecycle=\'open\' AND (? IS NULL OR task_id=?)').get(input.workspaceId, input.projectId, input.recipient['sessionId'], input.taskId ?? null, input.taskId ?? null) !== undefined;
      case 'user': {
        const userId = input.recipient['userId'];
        if (typeof userId !== 'string') return false;
        const raw = this.database.prepare('SELECT u.role,g.grants_json AS grantsJson FROM users u JOIN user_grants g ON g.user_id=u.id WHERE u.workspace_id=? AND u.id=? AND u.enabled=1').get(input.workspaceId, userId);
        if (!raw) return false;
        const row = z.object({ role: z.string(), grantsJson: z.string() }).parse(raw);
        return row.role === 'administrator' || z.object({ projectIds: z.array(z.string()) }).parse(parseJson(row.grantsJson)).projectIds.includes(input.projectId);
      }
      default: return false;
    }
  }
}
function assertNever(value: never): never { throw new TypeError(`Unexpected validity ${String(value)}`); }
