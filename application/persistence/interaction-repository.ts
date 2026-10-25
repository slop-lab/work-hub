import type { DatabaseSync } from 'node:sqlite';
import type { RequestView } from '../domain/model.ts';
import type { Clock } from './codec.ts';
import { RequestRecords } from './request-records.ts';
import type { NewRequest } from './request-codec.ts';
import { InteractionAuthority, type RequestContext } from './interaction-authority.ts';
import { ResponseRecords, type BridgePoll, type BridgeAck } from './response-records.ts';

export class InteractionRepository {
  readonly requests: RequestRecords;
  readonly responses: ResponseRecords;
  readonly authority: InteractionAuthority;
  constructor(database: DatabaseSync, clock: Clock) {
    this.requests = new RequestRecords(database, clock);
    this.authority = new InteractionAuthority(database, clock);
    this.responses = new ResponseRecords({ database, clock, authority: this.authority });
  }
  createRequest(input: NewRequest) { return this.requests.createRequest(input); }
  getRequest(workspaceId: string, id: string) { return this.requests.getRequest(workspaceId, id); }
  listRequests(workspaceId: string) { return this.requests.listRequests(workspaceId); }
  requestsForTask(workspaceId: string, taskId: string) { return this.requests.forTask(workspaceId, taskId); }
  requestsForSession(workspaceId: string, sessionId: string) { return this.requests.forSession(workspaceId, sessionId); }
  openRequests(workspaceId: string, limit: number) { return this.requests.openRequests(workspaceId, limit); }
  changeStatus(workspaceId: string, id: string, status: 'withdrawn' | 'expired' | 'superseded') { return this.requests.changeStatus(workspaceId, id, status); }
  reassign(workspaceId: string, id: string, recipient: object) { return this.requests.reassign(workspaceId, id, recipient); }
  unresolvedBlocking(workspaceId: string, taskId: string) { return this.requests.unresolvedBlocking(workspaceId, taskId); }
  invalidateNativeRequest(input: Parameters<RequestRecords['invalidateNativeRequest']>[0]) { this.requests.invalidateNativeRequest(input); }
  commitResponse(input: Parameters<ResponseRecords['commitResponse']>[0]) { return this.responses.commitResponse(input); }
  bridgeResponses(input: BridgePoll) { return this.responses.bridgeResponses(input); }
  acknowledgeBridgeResponse(input: BridgeAck) { this.responses.acknowledgeBridgeResponse(input); }
  updateDelivery(responseId: string, status: 'acknowledged' | 'rejected' | 'unknown' | 'suppressed', evidence: object) { this.responses.updateDelivery(responseId, status, evidence); }
  acknowledgeDeliveryScoped(input: Omit<BridgeAck, 'attemptId'>) { this.responses.acknowledgeDeliveryScoped(input); }
  attemptScope(workspaceId: string, attemptId: string) { return this.authority.attemptScope(workspaceId, attemptId); }
  validateRequestContext(input: RequestContext) { return this.authority.validateRequestContext(input); }
  validateSelectedResponses(workspaceId: string, taskId: string, responseIds: readonly string[]) { return this.authority.validateSelectedResponses(workspaceId, taskId, responseIds); }
  targetCurrent(request: RequestView) { return this.authority.targetCurrent(request); }
  deliveryAllowed(workspaceId: string, requestId: string, responseId: string) { return this.authority.deliveryAllowed(workspaceId, requestId, responseId); }
}
