import type { ActionContext, AgentRuntimeConnector, AttemptStart, CallContext, InstructionInput, OpenSessionInput,
  ResponseDelivery, RuntimeBindingDescriptor, RuntimeControlGrant, RuntimeRoute, RuntimeTarget, StopInput, StopResult } from '../../contracts/index.ts';
import { ResponseDeliveryResultSchema, RuntimeBindingDescriptorSchema, RuntimeDetachedResultSchema, StopResultSchema } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import { digest } from '../../persistence/codec.ts';
import type { ConnectorLedger } from '../ledger.ts';
import { codexCapabilities, codexManifest } from './capabilities.ts';
import { CodexInput } from './input.ts';
import { CodexObservation } from './observation.ts';
import { CodexAppServerProtocol, type CodexProtocol } from './protocol.ts';
import { accountReadResponseSchema, codexConnectionSchema, codexSelectionSchema, modelListResponseSchema,
  threadListResponseSchema, threadStartResponseSchema, type CodexConnection } from './schema.ts';
import { toolRequestUserInputParamsSchema } from './schema.ts';
import { CodexState } from './state.ts';

export type CodexDiscovery = { readonly version: string; readonly directory: string;
  readonly agents: readonly { readonly id: 'codex'; readonly label: 'Codex CLI' }[];
  readonly models: readonly { readonly id: string; readonly label: string; readonly isDefault: boolean }[];
  readonly sessions: readonly { readonly nativeRef: ReturnType<CodexState['reference']>; readonly modelProvider: string; readonly model: string | null }[];
  readonly capabilities: typeof codexCapabilities; readonly limitations: readonly string[] };

export class CodexRuntimeConnector implements AgentRuntimeConnector {
  readonly state: CodexState;
  private readonly protocol: CodexProtocol;
  private readonly input: CodexInput;
  private readonly observations: CodexObservation;
  constructor(ledger: ConnectorLedger, connectionInput: CodexConnection, protocol?: CodexProtocol) {
    const connection = codexConnectionSchema.parse(connectionInput);
    this.protocol = protocol ?? new CodexAppServerProtocol(connection);
    this.state = new CodexState(ledger, connection);
    this.input = new CodexInput(this.protocol, this.state);
    this.observations = new CodexObservation(this.protocol, this.state);
  }
  describe() { return { manifest: codexManifest, capabilities: codexCapabilities }; }
  private checkRoute(ctx: CallContext, route: RuntimeRoute): void {
    this.state.checkInstallation(ctx);
    const mapping = this.state.connection.environment;
    if (mapping && route.kind !== 'environment') throw new HubError({ code: 'codex_environment_required', category: 'authorization',
      message: 'This Codex connection requires its mapped environment.', retry: 'never' });
    if (route.kind === 'external') {
      if (mapping || route.route.ownerInstallationId !== ctx.installationId) throw new HubError({ code: 'codex_route_mismatch',
        category: 'identity_mismatch', message: 'This Codex connection does not match the selected external route.', retry: 'never' });
      return;
    }
    const identity = route.attachment.identity.native;
    if (!mapping || identity.installationId !== mapping.executionInstallationId || identity.providerScope !== mapping.hostId ||
      identity.id !== mapping.workspaceId || identity.incarnation !== mapping.incarnation ||
      !route.attachment.routes.some((item) => JSON.stringify(item) === JSON.stringify(route.route)) ||
      (route.route.expiresAt !== undefined && Date.parse(route.route.expiresAt) <= Date.now()) ||
      (route.attachment.useGrant.expiresAt !== undefined && Date.parse(route.attachment.useGrant.expiresAt) <= Date.now()) ||
      !route.attachment.useGrant.allowedWorkAreas.some((area) => area.path === this.state.connection.directory)) throw new HubError({
      code: 'codex_environment_mismatch', category: 'identity_mismatch',
      message: 'The Codex connection does not match this exact mapped environment and directory.', retry: 'never' });
  }
  private observation<T>(ctx: CallContext, value: T, limitations: readonly string[] = []) {
    return { value, sourceInstallationId: ctx.installationId, observedAt: new Date().toISOString(), assurance: 'reported' as const, limitations };
  }
  async discover(ctx: CallContext): Promise<CodexDiscovery> {
    this.state.checkInstallation(ctx);
    const [version, account, models, sessions] = await Promise.all([
      this.protocol.version(),
      this.protocol.request('account/read', { refreshToken: false }).then((value) => accountReadResponseSchema.parse(value)),
      this.protocol.request('model/list', { includeHidden: false, limit: 100 }).then((value) => modelListResponseSchema.parse(value)),
      this.protocol.request('thread/list', { cwd: this.state.connection.directory, modelProviders: [this.state.connection.modelProvider], limit: 100 })
        .then((value) => threadListResponseSchema.parse(value)),
    ]);
    const limitations = [
      'Discovery is scoped to the configured directory and model provider; it is not a host-wide session inventory.',
      'Authentication status is reduced to readiness and never exposes account or credential payloads.',
      ...(account.requiresOpenaiAuth && account.account === null ? ['Codex reports no authenticated account for this scoped installation.'] : []),
    ];
    return { version, directory: this.state.connection.directory, agents: [{ id: 'codex', label: 'Codex CLI' }],
      models: models.data.map((model) => ({ id: model.id, label: model.displayName, isDefault: model.isDefault })),
      sessions: sessions.data.filter((thread) => thread.cwd === this.state.connection.directory && thread.modelProvider === this.state.connection.modelProvider)
        .map((thread) => ({ nativeRef: this.state.reference('agent-thread', thread.id), modelProvider: thread.modelProvider, model: thread.model })),
      capabilities: codexCapabilities, limitations };
  }
  async probe(ctx: CallContext, route: RuntimeRoute) {
    this.checkRoute(ctx, route);
    const [inventory, account] = await Promise.all([this.discover(ctx),
      this.protocol.request('account/read', { refreshToken: false }).then((value) => accountReadResponseSchema.parse(value))]);
    const selected = inventory.models.some((model) => model.id === this.state.connection.model);
    const authenticated = !account.requiresOpenaiAuth || account.account !== null;
    const unmetRequirements = [...(authenticated ? [] : ['Codex authentication is unavailable for this scoped installation.']),
      ...(selected ? [] : ['Configured Codex model is unavailable.'])];
    return this.observation(ctx, { ready: authenticated && selected, unmetRequirements }, inventory.limitations);
  }
  async openSession(ctx: ActionContext, input: OpenSessionInput) {
    this.checkRoute(ctx, input.route);
    if (input.route.kind === 'environment' && !ctx.authorizedGrantRefs.includes(input.route.attachment.useGrant.id)) throw new HubError({
      code: 'codex_environment_grant_required', category: 'authorization',
      message: 'The selected environment use grant is required to open a Codex thread.', retry: 'never' });
    const selection = codexSelectionSchema.parse(input.configuration);
    if (selection.model.modelID !== this.state.connection.model || selection.model.providerID !== this.state.connection.modelProvider) throw new HubError({
      code: 'codex_selection_mismatch', category: 'requirements_not_met', message: 'Codex model and provider must match the explicit configured selection.', retry: 'manual_action' });
    return this.state.ledger.execute<RuntimeBindingDescriptor>(ctx, { kind: 'runtime.openSession', schemaId: 'workhub.runtime.binding.v1',
      schema: RuntimeBindingDescriptorSchema, input, effect: 'session.opened' }, async () => {
      if (this.state.get(ctx, input.hubSessionId)) throw new HubError({ code: 'codex_already_bound', category: 'conflict',
        message: 'This Hub session already has a Codex thread binding.', retry: 'never' });
      const response = input.mode === 'create'
        ? threadStartResponseSchema.parse(await this.protocol.request('thread/start', { cwd: this.state.connection.directory,
          model: selection.model.modelID, modelProvider: selection.model.providerID, ephemeral: false, approvalPolicy: 'never' }))
        : threadStartResponseSchema.parse(await this.protocol.request('thread/resume', { threadId: input.nativeSession.id }));
      const thread = response.thread;
      if (thread.ephemeral || thread.cwd !== this.state.connection.directory || thread.modelProvider !== selection.model.providerID ||
        thread.model !== selection.model.modelID || (input.mode === 'attach' && JSON.stringify(input.nativeSession) !== JSON.stringify(this.state.reference('agent-thread', thread.id)))) {
        throw new HubError({ code: 'codex_identity_mismatch', category: 'identity_mismatch',
          message: 'Codex thread identity, durability, directory, provider, or model differs from the configured selection.', retry: 'never' });
      }
      this.state.save(ctx, input.hubSessionId, { workspaceId: ctx.workspaceId, nativeId: thread.id, mode: input.requestedControl,
        selection, detached: false, environmentGrant: input.route.kind === 'environment' ? input.route.attachment.useGrant : null, ownedInputs: [] });
      return { nativeSession: this.state.reference('agent-thread', thread.id), nativeIdentityAssurance: 'attested',
        origin: input.mode === 'create' ? 'created' : 'attached_existing', route: input.route.route,
        controlGrant: { id: `codex:${input.hubSessionId}`, mode: input.requestedControl,
          allowedActions: input.requestedControl === 'control' ? ['start_attempt', 'send_instruction', 'deliver_response', 'request_stop'] : [],
          externalClientsMayAlsoControl: true }, capabilities: codexCapabilities, history: 'partial' };
    });
  }
  async requestControl(_ctx: ActionContext, _input: { readonly target: RuntimeTarget; readonly requestedActions: RuntimeControlGrant['allowedActions'] }): Promise<never> {
    throw new HubError({ code: 'codex_control_transfer_unsupported', category: 'unsupported',
      message: 'Attach deliberately with control; Codex has no exclusive control transfer primitive.', retry: 'never' });
  }
  startAttempt(ctx: ActionContext, input: AttemptStart) { return this.input.send(ctx, input); }
  sendInstruction(ctx: ActionContext, input: InstructionInput) { return this.input.send(ctx, input); }
  async deliverResponse(ctx: ActionContext, input: ResponseDelivery) {
    const binding = this.state.target(ctx, input.target, 'input');
    const attempt = binding.attempt;
    if (!attempt || attempt.id !== input.target.hubAttemptId || input.nativeRequestRef.installationId !== ctx.installationId ||
      input.nativeRequestRef.providerScope !== this.state.connection.directory || input.nativeRequestRef.kind !== 'question') {
      throw new HubError({ code: 'codex_question_scope', category: 'identity_mismatch',
        message: 'The Codex question is outside this attempt binding.', retry: 'never' });
    }
    return this.state.ledger.execute(ctx, { kind: 'runtime.deliverResponse', schemaId: 'workhub.runtime.response-receipt.v1',
      schema: ResponseDeliveryResultSchema, input, effect: 'response.acknowledged' }, async () => {
      const event = this.protocol.pendingServerRequests().find((candidate) => candidate.nativeRequestId === input.nativeRequestRef.id);
      const parsed = toolRequestUserInputParamsSchema.safeParse(event?.params);
      const question = parsed.success ? parsed.data.questions[0] : undefined;
      const revision = parsed.success ? digest(parsed.data) : undefined;
      if (!event?.nativeRequestId || !parsed.success || parsed.data.questions.length !== 1 || !question || question.isSecret ||
        parsed.data.threadId !== binding.nativeId || parsed.data.turnId !== attempt.turnId || input.validity.kind !== 'attempt' ||
        input.validity.nativeRequestRevision !== revision) throw new HubError({ code: 'codex_question_changed', category: 'conflict',
        message: 'The native question is no longer current or has an unsupported shape. Inspect it in an authenticated native Codex client.', retry: 'manual_action' });
      let answer: string;
      switch (input.answer.kind) {
        case 'text': {
          if (question.options !== null) throw new HubError({ code: 'codex_question_answer_kind', category: 'validation',
            message: 'This Codex question requires one listed option.', retry: 'never' });
          answer = input.answer.text;
          break;
        }
        case 'single_choice': {
          const option = question.options?.[Number(input.answer.optionId)];
          if (!option || question.isOther) throw new HubError({ code: 'codex_question_option_missing', category: 'validation',
            message: 'The selected Codex option is unavailable.', retry: 'never' });
          answer = option.label;
          break;
        }
        case 'approval': throw new HubError({ code: 'codex_approval_unsupported', category: 'unsupported',
          message: 'Codex approvals are never autoapproved; use an authenticated native Codex client.', retry: 'never' });
      }
      const nativeRequestId = event.nativeRequestId;
      await this.protocol.respondServerRequest(nativeRequestId, { answers: { [question.id]: { answers: [answer] } } });
      return { responseId: input.responseId, receiptRef: this.state.reference('question-response', nativeRequestId) };
    });
  }
  async requestStop(ctx: ActionContext, input: StopInput) {
    const binding = this.state.target(ctx, input.target, 'stop');
    if (input.mode !== 'interrupt' || binding.attempt?.id !== input.target.hubAttemptId) throw new HubError({
      code: 'codex_stop_unsupported', category: 'unsupported', message: 'Only interrupt of the bound Codex turn is supported.', retry: 'never' });
    return this.state.ledger.execute<StopResult>(ctx, { kind: 'runtime.requestStop', schemaId: 'workhub.runtime.stop-result.v1',
      schema: StopResultSchema, input, effect: 'attempt.stop_requested' }, async () => {
      await this.protocol.request('turn/interrupt', { threadId: binding.nativeId, turnId: binding.attempt?.turnId });
      return { effect: 'request_accepted' };
    });
  }
  async inspectSession(ctx: CallContext, target: RuntimeTarget) { return this.observation(ctx, await this.observations.inspect(ctx, target)); }
  readOutput(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string; readonly limit: number }) { return this.observations.output(ctx, input); }
  subscribe(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string }) { return this.observations.events(ctx, input.target); }
  async detachSession(ctx: ActionContext, target: RuntimeTarget) {
    const binding = this.state.target(ctx, target);
    return this.state.ledger.execute<{ readonly detached: true }>(ctx, { kind: 'runtime.detachSession', schemaId: 'workhub.runtime.detached.v1',
      schema: RuntimeDetachedResultSchema, input: target, effect: 'session.detached' }, async () => {
      this.state.save(ctx, target.hubSessionId, { ...binding, detached: true }); return { detached: true };
    });
  }
  lookupOperation(ctx: CallContext, operationId: string) { return this.input.lookup(ctx, operationId); }
  async close(): Promise<void> { await this.protocol.close(); }
}
