import type { Actor } from './authorization.ts';
import type { RequestView } from './model.ts';

export function canActOnRequest(actor: Actor, request: RequestView): boolean {
  if (actor.role !== 'administrator' && !actor.projectIds.includes(request.projectId)) return false;
  switch (request.recipient['kind']) {
    case 'user': return request.recipient['userId'] === actor.id;
    case 'project_members': return request.recipient['projectId'] === request.projectId && actor.role !== 'runtime';
    case 'agent_session': return actor.role === 'runtime' && request.recipient['sessionId'] === actor.sessionId;
    default: return false;
  }
}
