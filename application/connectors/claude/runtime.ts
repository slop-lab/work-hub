import { randomUUID } from 'node:crypto';
import type { ActionContext, AgentRuntimeConnector, AttemptStart, CallContext, InstructionInput, OpenSessionInput,
  ResponseDelivery, RuntimeBindingDescriptor, RuntimeControlGrant, RuntimeRoute, RuntimeTarget, StopInput } from '../../contracts/index.ts';
import { InputReceiptSchema, RuntimeBindingDescriptorSchema, RuntimeDetachedResultSchema } from '../../contracts/index.ts';
import { HubError } from '../../domain/errors.ts';
import { digest } from '../../persistence/codec.ts';
import type { ConnectorLedger } from '../ledger.ts';
import { claudeCapabilities, claudeManifest } from './capabilities.ts';
import { OfficialClaudeSdkDriver, type ClaudeSdkDriver } from './driver.ts';
import { ClaudeObservation } from './observation.ts';
import { claudeConnectionSchema, claudeDiscoverySchema, claudeSelectionSchema,
  type ClaudeBoundMessage, type ClaudeConnection, type ClaudeDiscovery } from './schema.ts';
import { ClaudeState } from './state.ts';

export class ClaudeCodeRuntimeConnector implements AgentRuntimeConnector {
  readonly state: ClaudeState;
  private readonly driver: ClaudeSdkDriver;
  private readonly observation: ClaudeObservation;
  private acceptingInput = true;
  private readonly activeInputs = new Set<Promise<void>>();

  constructor(ledger: ConnectorLedger, connectionInput: ClaudeConnection, driver?: ClaudeSdkDriver) {
    const connection = claudeConnectionSchema.parse(connectionInput);
    this.state = new ClaudeState(ledger, connection);
    this.driver = driver ?? new OfficialClaudeSdkDriver(connection);
    this.observation = new ClaudeObservation(this.state);
  }

  describe() { return { manifest: claudeManifest, capabilities: claudeCapabilities }; }

  async discover(ctx: CallContext): Promise<ClaudeDiscovery> {
    this.state.checkInstallation(ctx);
    const inventory = await this.driver.discover(ctx.signal);
    return claudeDiscoverySchema.parse({ installationId: ctx.installationId, runtimeKind: 'claude-code',
      label: this.state.connection.label, version: inventory.version, profiles: [],
      sessions: inventory.sessions.filter((item) => item.cwd === this.state.connection.directory).map((item) => ({
        nativeRef: this.state.reference('agent-session', item.sessionId),
        ...(item.summary === undefined ? {} : { label: item.summary }),
        ...(item.lastModified === undefined ? {} : { updatedAt: item.lastModified }),
      })), limitations: [
        'The stable Agent SDK cannot create an empty native session; attach an existing session before sending work.',
        'Models are deliberate configuration values because safe model discovery requires starting a query.',
        'Native approvals and questions stay in authenticated Claude Code.',
      ] });
  }

  private checkRoute(ctx: CallContext, route: RuntimeRoute): void {
    this.state.checkInstallation(ctx);
    const mapping = this.state.connection.environment;
    if (mapping && route.kind !== 'environment') throw new HubError({ code: 'claude_environment_required',
      category: 'authorization', message: 'This Claude Code connection requires its mapped environment.', retry: 'never' });
    if (route.kind === 'environment') {
      const identity = route.attachment.identity.native;
      if (!mapping || identity.installationId !== mapping.executionInstallationId || identity.providerScope !== mapping.hostId ||
        identity.id !== mapping.workspaceId || identity.incarnation !== mapping.incarnation ||
        !route.attachment.routes.some((item) => JSON.stringify(item) === JSON.stringify(route.route)) ||
        (route.route.expiresAt !== undefined && Date.parse(route.route.expiresAt) <= Date.now()) ||
        (route.attachment.useGrant.expiresAt !== undefined && Date.parse(route.attachment.useGrant.expiresAt) <= Date.now()) ||
        !route.attachment.useGrant.allowedWorkAreas.some((area) => area.path === this.state.connection.directory)) throw new HubError({
        code: 'claude_environment_mismatch', category: 'identity_mismatch',
        message: 'The Claude Code connection does not match this exact environment and directory.', retry: 'never' });
    }
  }

  async probe(ctx: CallContext, route: RuntimeRoute) {
    this.checkRoute(ctx, route);
    const inventory = await this.driver.discover(ctx.signal);
    const attachable = inventory.sessions.some((session) => session.cwd === this.state.connection.directory);
    return { value: { ready: attachable, unmetRequirements: attachable ? [] : ['No existing Claude Code session exists for this directory.'] },
      sourceInstallationId: ctx.installationId, observedAt: new Date().toISOString(), assurance: 'reported' as const,
      limitations: ['Local session inventory is readable. Authentication is verified only when an actual Agent SDK turn starts.'] };
  }

  async openSession(ctx: ActionContext, input: OpenSessionInput) {
    this.checkRoute(ctx, input.route);
    if (input.route.kind === 'environment' && !ctx.authorizedGrantRefs.includes(input.route.attachment.useGrant.id)) throw new HubError({
      code: 'claude_environment_grant_required', category: 'authorization',
      message: 'The selected environment use grant is required to attach a Claude Code session.', retry: 'never' });
    if (input.mode === 'create') throw new HubError({ code: 'claude_empty_session_unsupported', category: 'unsupported',
      message: 'The stable Claude Agent SDK cannot create an empty native session without sending a real prompt.', retry: 'never' });
    const selection = claudeSelectionSchema.parse(input.configuration);
    const native = await this.driver.getSession(input.nativeSession.id);
    if (!native || native.cwd !== this.state.connection.directory ||
      JSON.stringify(input.nativeSession) !== JSON.stringify(this.state.reference('agent-session', native.sessionId))) throw new HubError({
      code: 'claude_identity_mismatch', category: 'identity_mismatch',
      message: 'The exact Claude Code session and working directory could not be attested.', retry: 'never' });
    return this.state.ledger.execute<RuntimeBindingDescriptor>(ctx, { kind: 'runtime.openSession',
      schemaId: 'workhub.runtime.binding.v1', schema: RuntimeBindingDescriptorSchema, input, effect: 'session.opened' }, async () => {
      if (this.state.get(ctx, input.hubSessionId)) throw new HubError({ code: 'claude_already_bound', category: 'conflict',
        message: 'This Hub session already has a Claude Code binding.', retry: 'never' });
      this.state.save(ctx, input.hubSessionId, { workspaceId: ctx.workspaceId, nativeId: native.sessionId,
        mode: input.requestedControl, selection, detached: false, messages: [],
        environmentGrant: input.route.kind === 'environment' ? input.route.attachment.useGrant : null });
      return { nativeSession: this.state.reference('agent-session', native.sessionId), nativeIdentityAssurance: 'attested',
        origin: 'attached_existing', route: input.route.route, controlGrant: { id: `claude:${input.hubSessionId}`,
          mode: input.requestedControl, allowedActions: input.requestedControl === 'control' ? ['start_attempt', 'send_instruction'] : [],
          externalClientsMayAlsoControl: true }, capabilities: claudeCapabilities, history: 'partial' };
    });
  }

  async requestControl(_ctx: ActionContext, _input: { readonly target: RuntimeTarget;
    readonly requestedActions: RuntimeControlGrant['allowedActions'] }): Promise<never> {
    throw unsupported('control_transfer');
  }

  startAttempt(ctx: ActionContext, input: AttemptStart) {
    if (!this.acceptingInput) return Promise.reject(closingError());
    return this.track(this.send(ctx, input));
  }
  sendInstruction(ctx: ActionContext, input: InstructionInput) {
    if (!this.acceptingInput) return Promise.reject(closingError());
    return this.track(this.send(ctx, input));
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const drained = operation.then(() => undefined, () => undefined);
    this.activeInputs.add(drained);
    void drained.finally(() => this.activeInputs.delete(drained));
    return operation;
  }

  async close(): Promise<void> {
    this.acceptingInput = false;
    await Promise.all([...this.activeInputs]);
  }

  private async send(ctx: ActionContext, input: AttemptStart | InstructionInput) {
    const binding = this.state.target(ctx, input.target, true);
    const start = 'input' in input;
    if (!start && input.mode !== 'runtime_queued') throw unsupported('immediate_input');
    if (!start && binding.attempt?.id !== input.target.hubAttemptId) throw new HubError({ code: 'claude_attempt_mismatch',
      category: 'identity_mismatch', message: 'The follow-up targets another Claude Code attempt.', retry: 'never' });
    if (start && input.workAreas.some((area) => area.path !== this.state.connection.directory)) throw new HubError({
      code: 'claude_workarea_mismatch', category: 'identity_mismatch',
      message: 'The selected work area differs from the Claude Code directory.', retry: 'never' });
    if (start && binding.environmentGrant && input.workAreas.some((area) =>
      !binding.environmentGrant?.allowedWorkAreas.some((allowed) => area.key === allowed.key && area.path === allowed.path &&
        area.pathNamespace === allowed.pathNamespace && (area.requestedAccess === 'read' || allowed.requestedAccess === 'write')))) {
      throw new HubError({ code: 'claude_workarea_denied', category: 'authorization',
        message: 'The attempt exceeds its bound environment use grant.', retry: 'never' });
    }
    const prompt = start ? input.input.instruction : input.text;
    if (start && input.input.promptDigest !== undefined && digest(prompt) !== input.input.promptDigest) throw new HubError({
      code: 'claude_prompt_digest_mismatch', category: 'conflict',
      message: 'The rendered handoff prompt digest no longer matches the immutable input snapshot.', retry: 'never' });
    return this.state.ledger.execute(ctx, { kind: start ? 'runtime.startAttempt' : 'runtime.sendInstruction',
      schemaId: 'workhub.runtime.input-receipt.v1', schema: InputReceiptSchema, input,
      effect: start ? 'attempt.input_received' : 'instruction.accepted_by_runtime' }, async () => {
      const inputId = randomUUID();
      const attempt = start ? { id: input.target.hubAttemptId, taskId: input.input.taskId,
        generation: input.target.bindingGeneration, inputId } : binding.attempt;
      if (!attempt) throw new HubError({ code: 'claude_attempt_missing', category: 'conflict',
        message: 'A follow-up requires a bound attempt.', retry: 'never' });
      this.state.save(ctx, input.target.hubSessionId, { ...binding, attempt });
      const result = await this.driver.run({ sessionId: binding.nativeId, inputId, prompt, model: binding.selection.model });
      if (result.sessionId !== binding.nativeId || result.inputId !== inputId) throw new HubError({ code: 'claude_resume_identity_mismatch',
        category: 'identity_mismatch', message: 'Claude Code resumed a different native session.', retry: 'never' });
      const messages: readonly ClaudeBoundMessage[] = result.messages.map((message) => ({
        attemptId: input.target.hubAttemptId, inputId, message,
      }));
      this.state.save(ctx, input.target.hubSessionId, { ...binding, attempt, messages: [...binding.messages, ...messages] });
      return { nativeInputRef: this.state.reference('input', inputId),
        nativeExecutionRef: this.state.reference('execution', inputId), acceptance: 'received' as const };
    });
  }

  async deliverResponse(_ctx: ActionContext, _input: ResponseDelivery): Promise<never> { throw unsupported('native_response'); }
  async requestStop(_ctx: ActionContext, _input: StopInput): Promise<never> { throw unsupported('stop'); }

  async inspectSession(ctx: CallContext, target: RuntimeTarget) {
    return { value: this.observation.inspect(ctx, target),
      sourceInstallationId: ctx.installationId, observedAt: new Date().toISOString(), assurance: 'reported' as const, limitations: [] };
  }

  async readOutput(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string; readonly limit: number }) {
    return this.observation.output(ctx, input);
  }

  subscribe(ctx: CallContext, input: { readonly target: RuntimeTarget; readonly after?: string }) {
    return this.observation.events(ctx, input);
  }

  async detachSession(ctx: ActionContext, target: RuntimeTarget) {
    const binding = this.state.target(ctx, target);
    return this.state.ledger.execute(ctx, { kind: 'runtime.detachSession', schemaId: 'workhub.runtime.detached.v1',
      schema: RuntimeDetachedResultSchema, input: target, effect: 'session.detached' }, async () => {
      this.state.save(ctx, target.hubSessionId, { ...binding, detached: true });
      return { detached: true as const };
    });
  }

  lookupOperation(ctx: CallContext, operationId: string) {
    this.state.checkInstallation(ctx);
    return Promise.resolve(this.state.ledger.lookup(ctx, operationId));
  }
}

function unsupported(feature: string): HubError {
  return new HubError({ code: `claude_${feature}_unsupported`, category: 'unsupported',
    message: `Claude Code ${feature.replaceAll('_', ' ')} is not supported by this connector.`, retry: 'never' });
}

function closingError(): HubError {
  return new HubError({ code: 'claude_connector_closing', category: 'unavailable',
    message: 'The Claude Code connector is closing and no longer accepts new input.', retry: 'manual_action' });
}
