import type { z } from 'zod';
import { requireCommandScope, type Actor } from '../domain/authorization.ts';
import { conflict } from '../domain/errors.ts';
import type { HubCommandReceipt } from '../domain/model.ts';
import type { Store } from '../persistence/database.ts';
import { digest } from '../persistence/codec.ts';
import { OperationRepository } from '../persistence/operation-repository.ts';
import {
  externalCaptureSchema,
  externalCaptureSelectionSchema,
  externalContextCaptureSchema,
  externalContextCaptureSelectionSchema,
  ReferenceRepository,
} from './references.ts';

export type ExternalCapture = z.infer<typeof externalCaptureSchema>;
export type ExternalCaptureSelection = z.infer<typeof externalCaptureSelectionSchema>;
export type ExternalCaptureRequest = ExternalCapture | ExternalCaptureSelection;
export type ExternalContextCapture = z.infer<typeof externalContextCaptureSchema>;
export type ExternalContextCaptureSelection = z.infer<typeof externalContextCaptureSelectionSchema>;

export class ExternalCaptureService {
  private readonly store: Store;
  private readonly operations: OperationRepository;
  private readonly references: ReferenceRepository;
  constructor(store: Store) {
    this.store = store;
    this.operations = new OperationRepository(store.database, store.clock);
    this.references = new ReferenceRepository(store);
  }
  preflight(actor: Actor, value: ExternalCaptureSelection) {
    const selection = externalCaptureSelectionSchema.parse(value);
    const command = this.command(selection);
    const payloadDigest = digest(command);
    return this.store.transaction(() => {
      requireCommandScope(actor, 'reference.create');
      this.references.assertExternalCaptureAccess(actor, selection.taskId);
      return this.replay(actor, selection.commandId, payloadDigest);
    });
  }
  capture(actor: Actor, value: ExternalCapture) {
    const input = externalCaptureSchema.parse(value);
    const selection = externalCaptureSelectionSchema.parse({ commandId: input.commandId, taskId: input.taskId,
      installationId: input.installationId, pageId: input.pageId, revision: input.revision });
    const command = this.command(selection);
    const payloadDigest = digest(command);
    return this.store.transaction(() => {
      requireCommandScope(actor, 'reference.create');
      this.references.assertExternalCaptureAccess(actor, selection.taskId);
      const existing = this.replay(actor, selection.commandId, payloadDigest);
      if (existing !== undefined) return existing;
      const reference = this.references.captureExternal(actor, input);
      const receipt: HubCommandReceipt = { commandId: input.commandId, actorId: actor.id, status: 'confirmed',
        confirmedEffect: 'reference.persisted', objectRefs: [reference], operationIds: [] };
      this.operations.saveReceipt({ workspaceId: actor.workspaceId, actorId: actor.id, commandId: input.commandId,
        commandType: command.type, payloadDigest, command, receipt });
      this.operations.audit({ workspaceId: actor.workspaceId, actorId: actor.id, action: command.type,
        targetKind: 'reference', targetId: reference.id, commandId: input.commandId,
        summary: { status: 'confirmed', objectRefs: [reference] } });
      return reference;
    });
  }
  preflightContext(actor: Actor, value: ExternalContextCaptureSelection) {
    const selection = externalContextCaptureSelectionSchema.parse(value);
    const command = this.contextCommand(selection);
    const payloadDigest = digest(command);
    return this.store.transaction(() => {
      requireCommandScope(actor, 'reference.create');
      this.references.assertExternalCaptureAccess(actor, selection.taskId);
      return this.replayAll(actor, selection.commandId, payloadDigest);
    });
  }
  captureContext(actor: Actor, value: ExternalContextCapture) {
    const input = externalContextCaptureSchema.parse(value);
    const selection = externalContextCaptureSelectionSchema.parse({ commandId: input.commandId,
      taskId: input.taskId, installationId: input.installationId, contextRequest: input.contextRequest });
    const command = this.contextCommand(selection);
    const payloadDigest = digest(command);
    return this.store.transaction(() => {
      requireCommandScope(actor, 'reference.create');
      this.references.assertExternalCaptureAccess(actor, selection.taskId);
      const existing = this.replayAll(actor, selection.commandId, payloadDigest);
      if (existing !== undefined) return existing;
      const references = this.references.captureExternalContext(actor, input);
      const receipt: HubCommandReceipt = { commandId: input.commandId, actorId: actor.id, status: 'confirmed',
        confirmedEffect: 'references.persisted', objectRefs: references, operationIds: [] };
      this.operations.saveReceipt({ workspaceId: actor.workspaceId, actorId: actor.id, commandId: input.commandId,
        commandType: command.type, payloadDigest, command, receipt });
      this.operations.audit({ workspaceId: actor.workspaceId, actorId: actor.id, action: command.type,
        targetKind: 'task', targetId: input.taskId, commandId: input.commandId,
        summary: { status: 'confirmed', objectRefs: references } });
      return references;
    });
  }
  private command(selection: ExternalCaptureSelection) {
    return { commandId: selection.commandId, type: 'reference.capture',
      target: { kind: 'task', id: selection.taskId }, payload: {
        taskId: selection.taskId, installationId: selection.installationId,
        pageId: selection.pageId, revision: selection.revision,
      } };
  }
  private contextCommand(selection: ExternalContextCaptureSelection) {
    return { commandId: selection.commandId, type: 'reference.capture_context',
      target: { kind: 'task', id: selection.taskId }, payload: {
        taskId: selection.taskId, installationId: selection.installationId,
        contextRequest: selection.contextRequest,
      } };
  }
  private replay(actor: Actor, commandId: string, payloadDigest: string) {
    const existing = this.operations.findReceipt(actor.workspaceId, actor.id, commandId);
    if (existing === undefined) return undefined;
    if (existing.digest !== payloadDigest) throw conflict('idempotency_key_conflict', 'Command ID was already used with different capture input.');
    const reference = existing.receipt.objectRefs.find((item) => item.kind === 'reference');
    if (reference === undefined) throw new TypeError('External capture receipt has no reference.');
    return { kind: 'reference' as const, id: reference.id, revision: 1 as const };
  }
  private replayAll(actor: Actor, commandId: string, payloadDigest: string) {
    const existing = this.operations.findReceipt(actor.workspaceId, actor.id, commandId);
    if (existing === undefined) return undefined;
    if (existing.digest !== payloadDigest) throw conflict('idempotency_key_conflict',
      'Command ID was already used with different capture input.');
    const references = existing.receipt.objectRefs.filter((item) => item.kind === 'reference')
      .map((item) => ({ kind: 'reference' as const, id: item.id, revision: 1 as const }));
    if (references.length === 0) throw new TypeError('External context capture receipt has no references.');
    return references;
  }
}
