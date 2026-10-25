import type { Actor } from '../domain/authorization.ts';
import { conflict, forbidden, invalid } from '../domain/errors.ts';
import type { InteractionRepository } from '../persistence/interaction-repository.ts';
import { digest } from '../persistence/codec.ts';
import type { CommandOf } from './types.ts';

export function validatePublication(actor: Actor, payload: CommandOf<'request.create'>['payload'], interactions: InteractionRepository): void {
  const context = { workspaceId: actor.workspaceId, projectId: payload.projectId, recipient: payload.recipient, kind: payload.kind, validity: payload.validity, responseRoute: payload.responseRoute,
    ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    ...(payload.attemptId === undefined ? {} : { attemptId: payload.attemptId }),
    ...(payload.bindingGeneration === undefined ? {} : { bindingGeneration: payload.bindingGeneration }),
  };
  if (!interactions.validateRequestContext(context)) throw conflict('request_context_mismatch', 'The request identifiers do not belong to the same project, task and session.');
  if (!interactions.authority.recipientEligible(context)) throw invalid('recipient_unavailable', 'Select an enabled recipient with access to this project.');
  if (!interactions.authority.validityMatchesContext(context)) throw conflict('request_context_mismatch', 'The validity target differs from the request context.');
  if (payload.validity.kind === 'attempt' && !interactions.authority.targetCurrent(context)) throw conflict('request_target_stale', 'The request target or its grant is no longer current.');
  if (payload.kind === 'question' && payload.answerSchema.kind === 'approval') throw invalid('approval_kind_required', 'An approve/deny schema requires an explicit action approval request.');
  if (actor.role === 'runtime') {
    if (actor.sessionId !== payload.sessionId || actor.attemptId !== payload.attemptId || actor.bindingGeneration !== payload.bindingGeneration) throw forbidden('The runtime request is outside its credential scope.');
    if (!payload.attemptId) throw forbidden('Runtime questions require an attempt.');
    const scope = interactions.attemptScope(actor.workspaceId, payload.attemptId);
    if (scope.taskId !== payload.taskId || scope.sessionId !== payload.sessionId) throw forbidden('The runtime request cannot select another task.');
  }
  if (payload.kind === 'approval') {
    if (actor.role === 'member') throw forbidden('Members cannot author privileged action approvals.');
    if (payload.answerSchema.kind !== 'approval' || payload.validity.kind !== 'attempt' || !payload.actionDescription || payload.validity.actionDigest !== digest(payload.actionDescription) || !payload.validity.policyRevision) throw invalid('approval_scope_missing', 'Approval must bind the exact described action, policy, attempt and target.');
  }
  if (payload.responseRoute === 'native' && (payload.validity.kind !== 'attempt' || !payload.validity.nativeRequestRef)) throw invalid('native_request_missing', 'Native delivery requires a pinned native request identity.');
  if (payload.recipient.kind === 'agent_session') {
    if (payload.recipient.sessionId !== payload.sessionId || payload.attemptId === undefined || payload.bindingGeneration === undefined) throw conflict('request_context_mismatch', 'An agent recipient requires an explicit session, attempt and binding generation.');
    if (payload.responseRoute !== 'none') throw invalid('agent_response_route_invalid', 'An agent answer is committed to the Hub, not delivered back to the answering runtime.');
    if (!interactions.authority.targetCurrent(context)) throw conflict('request_target_stale', 'The agent recipient attempt is no longer active.');
  }
  if (payload.supersedesRequestId) {
    const previous = interactions.getRequest(actor.workspaceId, payload.supersedesRequestId);
    if (previous.projectId !== payload.projectId || previous.taskId !== payload.taskId || (actor.role !== 'administrator' && previous.authorId !== actor.id)) throw forbidden('A correction must preserve the original request context and authority.');
  }
}
