import { z } from 'zod';
import type { ActionContext, AgentRuntimeConnector, AttemptStart, CallContext, InstructionInput,
  OpenSessionInput, ResponseDelivery, RuntimeBindingDescriptor, RuntimeControlGrant, RuntimeRoute, RuntimeTarget, StopInput, StopResult } from '../../contracts/index.ts';
import { ResponseDeliveryResultSchema, RuntimeBindingDescriptorSchema, RuntimeDetachedResultSchema, StopResultSchema } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import { digest } from '../../persistence/codec.ts';
import type { ConnectorLedger } from '../ledger.ts';
import { OpenCodeClient } from './client.ts';
import { openCodeCapabilities, openCodeManifest } from './capabilities.ts';
import { OpenCodeInput } from './input.ts';
import { OpenCodeObservation } from './observation.ts';
import { selectionSchema, sessionSchema, type OpenCodeConnection } from './schema.ts';
import { OpenCodeState } from './state.ts';

export class OpenCodeRuntimeConnector implements AgentRuntimeConnector {
  readonly client: OpenCodeClient;
  readonly state: OpenCodeState;
  private readonly input: OpenCodeInput;
  private readonly observations: OpenCodeObservation;
  constructor(ledger: ConnectorLedger, connection: OpenCodeConnection) {
    this.client = new OpenCodeClient(connection);
    this.state = new OpenCodeState(ledger, connection);
    this.input = new OpenCodeInput(this.client, this.state);
    this.observations = new OpenCodeObservation(this.client, this.state);
  }
  describe() { return { manifest: openCodeManifest, capabilities: openCodeCapabilities }; }
  private observation<T>(ctx: CallContext, value: T) {
    return { value, sourceInstallationId: ctx.installationId, observedAt: new Date().toISOString(),
      assurance: 'reported' as const, limitations: [] };
  }
  private checkRoute(ctx: CallContext, route: RuntimeRoute): void {
    this.state.checkInstallation(ctx);
    if (this.client.connection.environment && route.kind !== 'environment') throw new HubError({
      code: 'opencode_environment_required', category: 'authorization',
      message: 'This runtime requires its mapped DIM environment binding; environment-free delegation is not permitted.', retry: 'never' });
    if (route.kind === 'environment') {
      const mapping = this.client.connection.environment;
      const identity = route.attachment.identity.native;
      if (!mapping || identity.installationId !== mapping.executionInstallationId ||
        identity.providerScope !== mapping.hostId || identity.id !== mapping.workspaceId ||
        identity.incarnation !== mapping.incarnation ||
        !route.attachment.routes.some((allowed) => digest(allowed) === digest(route.route)) ||
        (route.route.expiresAt !== undefined && Date.parse(route.route.expiresAt) <= Date.now()) ||
        (route.attachment.useGrant.expiresAt !== undefined && Date.parse(route.attachment.useGrant.expiresAt) <= Date.now()) ||
        !route.attachment.useGrant.allowedWorkAreas.some((area) => area.path === this.client.connection.directory)) {
        throw new HubError({ code: 'opencode_environment_mismatch', category: 'identity_mismatch',
          message: 'The runtime connection is not mapped to this exact DIM host, workspace incarnation and work directory.', retry: 'never' });
      }
    }
  }
  async probe(ctx: CallContext, route: RuntimeRoute) {
    this.checkRoute(ctx, route);
    await this.client.discover(ctx);
    return this.observation(ctx, { ready: true, unmetRequirements: [] });
  }
  async openSession(ctx: ActionContext, input: OpenSessionInput) {
    this.checkRoute(ctx, input.route);
    if (input.route.kind === 'environment' && !ctx.authorizedGrantRefs.includes(input.route.attachment.useGrant.id)) {
      throw new HubError({ code: 'opencode_environment_grant_required', category: 'authorization',
        message: 'The selected environment use grant is required to open a native session.', retry: 'never' });
    }
    const selection = selectionSchema.parse(input.configuration);
    await this.input.validateSelection(ctx, { selection });
    return this.state.ledger.execute<RuntimeBindingDescriptor>(ctx, { kind: 'runtime.openSession', schemaId: 'workhub.runtime.binding.v1',
      schema: RuntimeBindingDescriptorSchema, input, effect: 'session.opened' }, async () => {
      const existing = this.state.get(ctx, input.hubSessionId);
      if (existing) throw new HubError({ code: 'opencode_already_bound', category: 'conflict',
        message: 'This Hub session already has a native binding. Reconnect instead of creating a replacement.', retry: 'never' });
      const native = input.mode === 'attach' ? await this.client.session(ctx, input.nativeSession.id) :
        sessionSchema.parse(await this.client.request(ctx, '/session', { title: `Work Hub ${input.hubSessionId}` }));
      if (native.directory !== this.client.connection.directory || (input.mode === 'attach' &&
        JSON.stringify(input.nativeSession) !== JSON.stringify(this.state.reference('agent-session', native.id)))) {
        throw new HubError({ code: 'opencode_identity_mismatch', category: 'identity_mismatch',
          message: 'The native session identity or working directory differs from the selected connection.', retry: 'never' });
      }
      this.state.save(ctx, input.hubSessionId, { workspaceId: ctx.workspaceId, nativeId: native.id,
        mode: input.requestedControl, selection, detached: false, ownedInputs: [],
        environmentGrant: input.route.kind === 'environment' ? input.route.attachment.useGrant : null });
      return { nativeSession: this.state.reference('agent-session', native.id), nativeIdentityAssurance: 'attested',
        origin: input.mode === 'create' ? 'created' : 'attached_existing', route: input.route.route,
        controlGrant: { id: `opencode:${input.hubSessionId}`, mode: input.requestedControl,
          allowedActions: input.requestedControl === 'control' ? ['start_attempt', 'send_instruction', 'deliver_response', 'request_stop'] : [],
          externalClientsMayAlsoControl: true }, capabilities: openCodeCapabilities, history: 'partial' };
    });
  }
  async requestControl(_ctx: ActionContext, _input: { readonly target: RuntimeTarget; readonly requestedActions: RuntimeControlGrant['allowedActions'] }): Promise<never> {
    throw new HubError({ code: 'opencode_control_transfer_unsupported', category: 'unsupported',
      message: 'Attach deliberately with control; native exclusive control transfer is not supported.', retry: 'never' });
  }
  startAttempt(ctx: ActionContext, input: AttemptStart) { return this.input.send(ctx, input); }
  sendInstruction(ctx: ActionContext, input: InstructionInput) { return this.input.send(ctx, input); }
  async deliverResponse(ctx: ActionContext, input: ResponseDelivery) {
    const binding = this.state.target(ctx, input.target, 'input');
    if (binding.attempt?.id !== input.target.hubAttemptId || input.nativeRequestRef.installationId !== ctx.installationId ||
      input.nativeRequestRef.providerScope !== this.client.connection.directory || input.nativeRequestRef.kind !== 'question') {
      throw new HubError({ code: 'opencode_question_scope', category: 'identity_mismatch', message: 'The question is outside this attempt binding.', retry: 'never' });
    }
    return this.state.ledger.execute(ctx, { kind: 'runtime.deliverResponse', schemaId: 'workhub.runtime.response-receipt.v1',
      schema: ResponseDeliveryResultSchema, input, effect: 'response.acknowledged' }, async () => {
      const question = (await this.client.questions(ctx, binding.nativeId)).find((item) => item.id === input.nativeRequestRef.id);
      const item = question?.questions[0];
      if (!question || question.questions.length !== 1 || !item || item.multiple || input.validity.kind !== 'attempt' ||
        input.validity.nativeRequestRevision !== digest(question)) throw new HubError({ code: 'opencode_question_changed',
        category: 'conflict', message: 'The native question is no longer current or has an unsupported shape. Inspect it natively.', retry: 'manual_action' });
      let answer: string;
      switch (input.answer.kind) {
        case 'text': answer = input.answer.text; break;
        case 'single_choice': {
          const option = item.options[Number(input.answer.optionId)];
          if (!option) throw new HubError({ code: 'opencode_option_missing', category: 'validation', message: 'Selected option is unavailable.', retry: 'never' });
          answer = option.label; break;
        }
        case 'approval': throw new HubError({ code: 'opencode_approval_unsupported', category: 'unsupported',
          message: 'Native permission approvals are not mapped. Use the authenticated OpenCode view.', retry: 'never' });
      }
      z.literal(true).parse(await this.client.request(ctx, `/question/${encodeURIComponent(question.id)}/reply`, { answers: [[answer]] }));
      return { responseId: input.responseId, receiptRef: this.state.reference('question-response', question.id) };
    });
  }
  async requestStop(ctx: ActionContext, input: StopInput) {
    const binding = this.state.target(ctx, input.target, 'stop');
    if (input.mode !== 'interrupt' || binding.attempt?.id !== input.target.hubAttemptId) throw new HubError({
      code: 'opencode_stop_unsupported', category: 'unsupported', message: 'Only interrupt of the bound attempt is supported.', retry: 'never' });
    return this.state.ledger.execute<StopResult>(ctx, { kind: 'runtime.requestStop', schemaId: 'workhub.runtime.stop-result.v1',
      schema: StopResultSchema, input, effect: 'attempt.termination_observed' }, async () => {
      z.literal(true).parse(await this.client.request(ctx, `/session/${encodeURIComponent(binding.nativeId)}/abort`, {}));
      return { effect: 'request_accepted' };
    });
  }
  async inspectSession(ctx: CallContext, target: RuntimeTarget) {
    return this.observation(ctx, await this.observations.inspect(ctx, target));
  }
  readOutput(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string; readonly limit: number }) {
    return this.observations.output(ctx, input);
  }
  subscribe(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string }) {
    return this.observations.events(ctx, input.target);
  }
  async detachSession(ctx: ActionContext, target: RuntimeTarget) {
    const binding = this.state.target(ctx, target);
    return this.state.ledger.execute<{ readonly detached: true }>(ctx, { kind: 'runtime.detachSession', schemaId: 'workhub.runtime.detached.v1',
      schema: RuntimeDetachedResultSchema, input: target, effect: 'session.detached' }, async () => {
      this.state.save(ctx, target.hubSessionId, { ...binding, detached: true });
      return { detached: true };
    });
  }
  lookupOperation(ctx: CallContext, operationId: string) { return this.input.lookup(ctx, operationId); }
}
