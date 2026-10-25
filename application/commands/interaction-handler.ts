import type { Actor } from "../domain/authorization.ts";
import { requireProject } from "../domain/authorization.ts";
import { commandTargetId } from "../domain/commands.ts";
import { answerSchemaSchema, answerValueSchema } from "../domain/schema-common.ts";
import { conflict, invalid, forbidden } from "../domain/errors.ts";
import type { InteractionRepository } from "../persistence/interaction-repository.ts";
import type { OperationRepository } from "../persistence/operation-repository.ts";
import { digest } from "../persistence/codec.ts";
import { authorizeRequest, requireRevision } from "./guards.ts";
import type { CommandOf, CommandResult } from "./types.ts";
import { validatePublication } from './request-publication.ts';

export class InteractionHandler {
  private readonly interactions: InteractionRepository;
  private readonly operations: OperationRepository;
  private readonly now: () => Date;

  constructor(
    interactions: InteractionRepository,
    operations: OperationRepository,
    now: () => Date,
  ) {
    this.interactions = interactions;
    this.operations = operations;
    this.now = now;
  }

  create(actor: Actor, command: CommandOf<"request.create">): CommandResult {
    requireProject(actor, command.payload.projectId);
    validatePublication(actor, command.payload, this.interactions);
    if (command.payload.supersedesRequestId) this.interactions.changeStatus(actor.workspaceId, command.payload.supersedesRequestId, 'superseded');
    const request = this.interactions.createRequest({
      workspaceId: actor.workspaceId,
      authorId: actor.id,
      kind: command.payload.kind, projectId: command.payload.projectId,
      ...(command.payload.taskId === undefined ? {} : { taskId: command.payload.taskId }),
      ...(command.payload.sessionId === undefined ? {} : { sessionId: command.payload.sessionId }),
      ...(command.payload.attemptId === undefined ? {} : { attemptId: command.payload.attemptId }),
      ...(command.payload.bindingGeneration === undefined ? {} : { bindingGeneration: command.payload.bindingGeneration }),
      recipient: command.payload.recipient, prompt: command.payload.prompt,
      ...(command.payload.reason === undefined ? {} : { reason: command.payload.reason }),
      referenceIds: command.payload.referenceIds, answerSchema: command.payload.answerSchema,
      blocking: command.payload.blocking, validity: command.payload.validity,
      ...(command.payload.actionDescription === undefined ? {} : { actionDescription: command.payload.actionDescription }),
      ...(command.payload.supersedesRequestId === undefined ? {} : { supersedesRequestId: command.payload.supersedesRequestId }),
      responseRoute: command.payload.responseRoute,
    });
    return this.confirmed("request.persisted", "request", request.id, request.revision);
  }

  respond(actor: Actor, command: CommandOf<"request.respond">): CommandResult {
    const requestId = commandTargetId(command, "request");
    const request = this.interactions.getRequest(actor.workspaceId, requestId);
    authorizeRequest(actor, request);
    requireRevision(request.revision, command.expected?.request, "Request");
    if (request.status !== "open") {
      throw conflict("request_not_open", "The request is no longer open.");
    }
    if (request.expiresAt !== undefined && this.now().getTime() >= Date.parse(request.expiresAt)) {
      throw conflict("request_expired", "The request has expired.");
    }
    if (
      request.bindingGeneration !== undefined &&
      command.expected?.bindingGeneration !== request.bindingGeneration
    ) {
      throw conflict("binding_generation_conflict", "The request target generation changed.");
    }
    if (!this.interactions.targetCurrent(request)) {
      throw conflict("request_target_stale", "The request target is no longer current.");
    }
    if (request.kind === "approval" && typeof request.validity["actionDigest"] !== "string") {
      throw invalid("approval_scope_missing", "Approval validity must pin the exact action digest.");
    }
    this.validateAnswer(request.answerSchema, command.payload.answer);
    const response = this.interactions.commitResponse({
      workspaceId: actor.workspaceId,
      request,
      authorId: actor.id,
      answer: command.payload.answer,
    });
    if (request.responseRoute !== "native") {
      return this.confirmed("response.persisted", "response", response.id);
    }
    const operationId = this.operations.addOutbox({
      workspaceId: actor.workspaceId,
      commandId: command.commandId,
      workType: "runtime.deliverResponse",
      connectorKind: "runtime",
      installationId: this.nativeInstallation(request.validity),
      stage: "deliver_response",
      ...(request.attemptId === undefined ? {} : { targetId: request.attemptId }),
      ...(request.bindingGeneration === undefined ? {} : { targetGeneration: request.bindingGeneration }),
      inputDigest: digest({ requestId, responseId: response.id, answer: command.payload.answer }),
      payload: {
        requestId,
        requestRevision: request.revision,
        responseId: response.id,
        responseDigest: response.digest,
        answer: command.payload.answer,
        validity: request.validity,
      },
    });
    return {
      status: "confirmed",
      confirmedEffect: "response.persisted",
      objectRefs: [{ kind: "response", id: response.id }],
      operationIds: [operationId],
    };
  }

  withdraw(actor: Actor, command: CommandOf<"request.withdraw">): CommandResult {
    const id = commandTargetId(command, "request");
    const request = this.interactions.getRequest(actor.workspaceId, id);
    requireProject(actor, request.projectId);
    requireRevision(request.revision, command.expected?.request, "Request");
    if (actor.role !== "administrator" && request.authorId !== actor.id) {
      throw forbidden("Only the request author or an administrator may withdraw it.");
    }
    if (request.status !== "open") {
      throw conflict("request_not_open", "Only an open request can be withdrawn.");
    }
    const updated = this.interactions.changeStatus(actor.workspaceId, id, "withdrawn");
    return this.confirmed("request.withdrawn", "request", id, updated.revision);
  }

  reassign(actor: Actor, command: CommandOf<"request.reassign">): CommandResult {
    const id = commandTargetId(command, "request");
    const request = this.interactions.getRequest(actor.workspaceId, id);
    requireProject(actor, request.projectId);
    requireRevision(request.revision, command.expected?.request, "Request");
    if (actor.role !== "administrator" && request.authorId !== actor.id) {
      throw forbidden("Only the request author or an administrator may reassign it.");
    }
    if (request.status !== "open") {
      throw conflict("request_not_open", "Only an open request can be reassigned.");
    }
    if (!this.interactions.authority.recipientEligible({ workspaceId: actor.workspaceId, projectId: request.projectId, ...(request.taskId ? { taskId: request.taskId } : {}), recipient: command.payload.recipient })) throw invalid('recipient_unavailable', 'Select an enabled recipient in the same project.');
    const updated = this.interactions.reassign(actor.workspaceId, id, command.payload.recipient);
    return this.confirmed("request.reassigned", "request", id, updated.revision);
  }

  acknowledge(actor: Actor, command: CommandOf<"bridge.response.ack">): CommandResult {
    if (actor.role !== "runtime") {
      throw invalid("bridge_principal_required", "Bridge acknowledgments require a runtime principal.");
    }
    if (actor.bindingGeneration !== command.payload.bindingGeneration) {
      throw conflict("binding_generation_conflict", "Bridge credential generation does not match.");
    }
    if (actor.sessionId === undefined) {
      throw conflict("bridge_scope_mismatch", "Bridge credential is missing its session scope.");
    }
    this.interactions.acknowledgeBridgeResponse({
      workspaceId: actor.workspaceId,
      sessionId: actor.sessionId,
      ...(actor.attemptId === undefined ? {} : { attemptId: actor.attemptId }),
      ...command.payload,
    });
    return this.confirmed("response.acknowledged", "response", command.payload.responseId);
  }

  private validateAnswer(schemaInput: Readonly<Record<string, unknown>>, answerInput: object): void {
    const schema = answerSchemaSchema.parse(schemaInput);
    const answer = answerValueSchema.parse(answerInput);
    switch (schema.kind) {
      case "text":
        if (answer.kind !== "text" || answer.text.length < schema.minLength || answer.text.length > schema.maxLength || (schema.minLength > 0 && answer.text.trim().length === 0)) {
          throw invalid("answer_shape_mismatch", "The text answer does not satisfy the request schema.");
        }
        return;
      case "single_choice":
        if (answer.kind !== "single_choice" || !schema.options.some((option) => option.id === answer.optionId)) {
          throw invalid("answer_shape_mismatch", "The selected option is not valid for this request.");
        }
        return;
      case "approval":
        if (answer.kind !== "approval") {
          throw invalid("answer_shape_mismatch", "An explicit approval decision is required.");
        }
        return;
    }
  }

  private nativeInstallation(validity: Readonly<Record<string, unknown>>): string {
    const target = validity["target"];
    if (typeof target !== "object" || target === null) return "runtime-unknown";
    const nativeSession = Reflect.get(target, "nativeSession");
    if (typeof nativeSession !== "object" || nativeSession === null) return "runtime-unknown";
    const installationId = Reflect.get(nativeSession, "installationId");
    return typeof installationId === "string" ? installationId : "runtime-unknown";
  }

  private confirmed(effect: string, kind: string, id: string, revision?: number): CommandResult {
    return {
      status: "confirmed", confirmedEffect: effect,
      objectRefs: [{ kind, id, ...(revision === undefined ? {} : { revision }) }],
      operationIds: [],
    };
  }
}
