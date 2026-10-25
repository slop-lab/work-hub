import type { Actor } from "../domain/authorization.ts";
import { requireCommandScope } from "../domain/authorization.ts";
import { assertNever } from "../domain/assert-never.ts";
import type { HubCommand } from "../domain/commands.ts";
import { HubError, conflict } from "../domain/errors.ts";
import type { HubCommandReceipt } from "../domain/model.ts";
import { digest } from "../persistence/codec.ts";
import type { Store } from "../persistence/database.ts";
import type { OperationRepository } from "../persistence/operation-repository.ts";
import type { ContinuationHandler } from "./continuation-handler.ts";
import type { ExecutionHandler } from "./execution-handler.ts";
import type { InteractionHandler } from "./interaction-handler.ts";
import type { CommandResult } from "./types.ts";
import type { WorkHandler } from "./work-handler.ts";
import type { Administration, AdminCommand } from "../administration/index.ts";
import { ReferenceRepository } from '../artifacts/references.ts';
import { commandTargetId } from '../domain/commands.ts';

type ApplicationCommand = HubCommand | AdminCommand;

export class CommandService {
  private readonly store: Store;
  private readonly operations: OperationRepository;
  private readonly work: WorkHandler;
  private readonly interactions: InteractionHandler;
  private readonly execution: ExecutionHandler;
  private readonly continuations: ContinuationHandler;
  private readonly administration: Administration;
  private readonly references: ReferenceRepository;

  constructor(input: {
    readonly store: Store; readonly operations: OperationRepository;
    readonly work: WorkHandler; readonly interactions: InteractionHandler;
    readonly execution: ExecutionHandler; readonly continuations: ContinuationHandler;
    readonly administration: Administration;
  }) {
    this.store = input.store;
    this.operations = input.operations;
    this.work = input.work;
    this.interactions = input.interactions;
    this.execution = input.execution;
    this.continuations = input.continuations;
    this.administration = input.administration;
    this.references = new ReferenceRepository(input.store);
  }

  execute(actor: Actor, command: ApplicationCommand): HubCommandReceipt {
    const payloadDigest = digest(command);
    const existing = this.operations.findReceipt(actor.workspaceId, actor.id, command.commandId);
    if (existing !== undefined) {
      return existing.digest === payloadDigest
        ? existing.receipt
        : this.rejected(actor, command.commandId,
          conflict("idempotency_key_conflict", "Command ID was already used with different input."));
    }
    try {
      return this.store.transaction(() => {
        requireCommandScope(actor, command.type);
        const raced = this.operations.findReceipt(actor.workspaceId, actor.id, command.commandId);
        if (raced) return raced.digest === payloadDigest ? raced.receipt : this.rejected(actor, command.commandId, conflict('idempotency_key_conflict', 'Command ID was already used with different input.'));
        const result = this.dispatch(actor, command);
        const receipt = this.receipt(actor, command.commandId, result);
        this.operations.saveReceipt({
          workspaceId: actor.workspaceId, actorId: actor.id, commandId: command.commandId,
          commandType: command.type, payloadDigest, command, receipt,
        });
        this.operations.audit({
          workspaceId: actor.workspaceId, actorId: actor.id, action: command.type,
          ...(command.target === undefined ? receipt.objectRefs[0] ? { targetKind: receipt.objectRefs[0].kind, targetId: receipt.objectRefs[0].id } : {} : { targetKind: command.target.kind, targetId: command.target.id }),
          commandId: command.commandId,
          summary: { status: receipt.status, effect: receipt.confirmedEffect ?? null, objectRefs: receipt.objectRefs },
        });
        return receipt;
      });
    } catch (error) {
      if (error instanceof HubError) {
        return this.persistRejection(actor, command, payloadDigest, error);
      }
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return this.persistRejection(actor, command, payloadDigest,
          conflict("concurrency_conflict", "A conflicting command already reserved this resource."));
      }
      throw error;
    }
  }

  private dispatch(actor: Actor, command: ApplicationCommand): CommandResult {
    switch (command.type) {
      case 'reference.create': {
        const reference = this.references.create(actor, { taskId: commandTargetId(command, 'task'), reference: command.payload });
        return { status: 'confirmed', confirmedEffect: 'reference.persisted', objectRefs: [reference], operationIds: [] };
      }
      case 'user.create':
      case 'user.update':
      case 'user.disable':
      case 'project.create':
      case 'project.update':
      case 'installation.create':
      case 'installation.disable':
      case 'profile.create':
      case 'profile.update':
      case 'profile.disable':
      case 'attention.markRead':
      case 'attention.dismiss':
      case 'retention.apply': {
        const reference = this.administration.apply(actor, command);
        return { status: 'confirmed', confirmedEffect: `${reference.kind}.persisted`, objectRefs: [reference], operationIds: [] };
      }
      case "task.create": return this.work.create(actor, command);
      case "task.update": return this.work.update(actor, command);
      case "task.comment": return this.work.comment(actor, command);
      case "task.setStatus": return this.work.setStatus(actor, command);
      case "task.archive": return this.work.archive(actor, command);
      case "task.requestRevision": return this.requestRevision(actor, command);
      case "result.submit": return this.work.submitResult(actor, command);
      case 'attempt.report': return this.work.reportActivity(actor, command);
      case "request.create": return this.interactions.create(actor, command);
      case "request.respond": return this.interactions.respond(actor, command);
      case "request.withdraw": return this.interactions.withdraw(actor, command);
      case "request.reassign": return this.interactions.reassign(actor, command);
      case "bridge.response.ack": return this.interactions.acknowledge(actor, command);
      case "environment.register": return this.execution.register(actor, command);
      case "environment.verify": return this.execution.verify(actor, command);
      case "environment.retire": return this.execution.retire(actor, command);
      case "attempt.delegate": return this.execution.delegate(actor, command);
      case "session.attach": return this.execution.attach(actor, command);
      case "session.takeControl": return this.execution.takeControl(actor, command);
      case "session.instruct": return this.execution.instruct(actor, command);
      case "session.continue": return this.continuations.continue(actor, command);
      case "attempt.retry": return this.continuations.retry(actor, command);
      case "attempt.stop": return this.execution.stop(actor, command);
      case "session.close": return this.execution.close(actor, command);
      case "environment.detach": return this.execution.detach(actor, command);
      case "environment.release": return this.execution.release(actor, command);
      case "operation.reconcile": return this.execution.reconcile(actor, command);
      default: return assertNever(command);
    }
  }

  private requestRevision(
    actor: Actor,
    command: Extract<HubCommand, { readonly type: "task.requestRevision" }>,
  ): CommandResult {
    const dispatch = this.work.requestRevision(actor, command);
    const result = dispatch.path === "instruction"
      ? this.execution.instruct(actor, {
          commandId: command.commandId,
          type: "session.instruct",
          target: { kind: "session", id: dispatch.sessionId },
          expected: {
            ...(command.expected?.bindingGeneration === undefined ? {} : {
              bindingGeneration: command.expected.bindingGeneration,
            }),
          },
          payload: {
            attemptId: dispatch.attemptId,
            text: dispatch.instruction,
            referenceIds: [...dispatch.referenceIds],
            mode: dispatch.mode,
          },
        })
      : this.continuations.continue(actor, {
          commandId: command.commandId,
          type: "session.continue",
          target: { kind: "session", id: dispatch.sessionId },
          expected: {
            ...(command.expected?.task === undefined ? {} : { task: command.expected.task }),
            ...(command.expected?.session === undefined ? {} : { session: command.expected.session }),
            ...(command.expected?.profile === undefined ? {} : { profile: command.expected.profile }),
          },
          payload: {
            profileId: dispatch.profileId,
            context: dispatch.context,
            environmentReuse: dispatch.environmentReuse,
            instruction: dispatch.instruction,
            sourceResultId: dispatch.resultId,
          },
        });
    return {
      status: result.status,
      confirmedEffect: "revision.request.persisted",
      objectRefs: [{ kind: "task_entry", id: dispatch.entryId }, ...result.objectRefs],
      operationIds: result.operationIds,
    };
  }

  private receipt(actor: Actor, commandId: string, result: CommandResult): HubCommandReceipt {
    return {
      commandId, actorId: actor.id, status: result.status,
      ...(result.confirmedEffect === undefined ? {} : { confirmedEffect: result.confirmedEffect }),
      objectRefs: result.objectRefs, operationIds: result.operationIds,
    };
  }

  private rejected(actor: Actor, commandId: string, error: HubError): HubCommandReceipt {
    return {
      commandId, actorId: actor.id, status: "rejected",
      objectRefs: [], operationIds: [], error: error.data,
    };
  }

  private persistRejection(
    actor: Actor,
    command: ApplicationCommand,
    payloadDigest: string,
    error: HubError,
  ): HubCommandReceipt {
    const receipt = this.rejected(actor, command.commandId, error);
    return this.store.transaction(() => {
      this.operations.saveReceipt({
        workspaceId: actor.workspaceId, actorId: actor.id, commandId: command.commandId,
        commandType: command.type, payloadDigest, command, receipt,
      });
      this.operations.audit({
        workspaceId: actor.workspaceId, actorId: actor.id, action: command.type,
        ...(command.target === undefined ? {} : {
          targetKind: command.target.kind, targetId: command.target.id,
        }),
        commandId: command.commandId,
        summary: { status: "rejected", code: error.data.code },
      });
      return receipt;
    });
  }
}
