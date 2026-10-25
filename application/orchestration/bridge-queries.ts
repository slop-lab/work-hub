import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from '../domain/authorization.ts';
import { forbidden } from '../domain/errors.ts';
import type { InteractionRepository } from '../persistence/interaction-repository.ts';

export type RuntimeScope = {
  readonly workspaceId: string; readonly projectId: string; readonly taskId: string;
  readonly sessionId: string; readonly attemptId: string; readonly bindingGeneration: number;
};

export class BridgeQueries {
  private readonly database: DatabaseSync;
  private readonly interactions: InteractionRepository;
  constructor(database: DatabaseSync, interactions: InteractionRepository) {
    this.database = database;
    this.interactions = interactions;
  }

  assertScope(scope: RuntimeScope): void {
    const match = this.database.prepare(`SELECT a.id FROM attempts a
      JOIN sessions s ON s.id=a.session_id AND s.workspace_id=a.workspace_id
      WHERE a.workspace_id=? AND a.id=? AND a.task_id=? AND s.task_id=a.task_id
        AND s.id=? AND s.project_id=? AND s.binding_generation=? AND s.lifecycle='open'`)
      .get(scope.workspaceId, scope.attemptId, scope.taskId, scope.sessionId, scope.projectId, scope.bindingGeneration);
    if (match === undefined) throw forbidden('The runtime credential context does not match its canonical project, task, session, attempt and generation.');
  }

  requests(actor: Actor) {
    if (actor.role !== 'runtime' || actor.sessionId === undefined || actor.attemptId === undefined || actor.bindingGeneration === undefined) {
      throw forbidden('Agent request polling requires an exact runtime scope.');
    }
    return this.interactions.requests.agentRequests({ workspaceId: actor.workspaceId,
      sessionId: actor.sessionId, attemptId: actor.attemptId, bindingGeneration: actor.bindingGeneration,
    }).filter((request) => this.interactions.targetCurrent(request));
  }

  responses(actor: Actor, input: { readonly after?: string } = {}) {
    if (actor.role !== 'runtime' || actor.sessionId === undefined) throw forbidden('Bridge response polling requires a scoped runtime principal.');
    return this.interactions.bridgeResponses({ workspaceId: actor.workspaceId, sessionId: actor.sessionId,
      ...(actor.attemptId === undefined ? {} : { attemptId: actor.attemptId }),
      ...(actor.bindingGeneration === undefined ? {} : { bindingGeneration: actor.bindingGeneration }),
      ...(input.after === undefined ? {} : { after: input.after }) });
  }
}
