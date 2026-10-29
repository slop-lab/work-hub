import type { Actor } from "../domain/authorization.ts";
import { parseHubCommand } from "../domain/commands.ts";
import type { HubCommandReceipt, HubSnapshot } from "../domain/model.ts";
import { Store } from "../persistence/database.ts";
import { CommandService } from "../commands/service.ts";
import { Administration, adminCommandSchema } from "../administration/index.ts";
import { exportSafeRecords } from "../artifacts/export.ts";
import { ReferenceRepository } from '../artifacts/references.ts';
import { ExternalCaptureService, type ExternalCapture, type ExternalCaptureRequest,
  type ExternalCaptureSelection } from '../artifacts/external-capture.ts';
import { EventRepository } from '../persistence/events.ts';
import type { SimulatorCallLog, SimulatorControls, Simulators } from "../simulator/index.ts";
import { QueryService, type ContextQuery, type TaskListQuery } from "./query-service.ts";
import { OrchestrationWorker } from "./worker.ts";
import { BridgeQueries, type RuntimeScope } from './bridge-queries.ts';
import { HandoffService, type HandoffPreviewRequest, type RecipientAssignmentRequest,
  type RegisterRepositoryRequest } from "./handoff-service.ts";
import { createHubRuntime, type HubRuntimeOptions } from "./hub-runtime.ts";

export type { Actor } from "../domain/authorization.ts";
export type { HubCommand } from "../domain/commands.ts";
export type { HubCommandReceipt, HubSnapshot } from "../domain/model.ts";
export type { TaskListQuery } from "./query-service.ts";

export type HubOptions = HubRuntimeOptions;

export class Hub {
  readonly readiness: {
    readonly coreReady: boolean;
    readonly liveIntegrationReady: boolean;
    readonly simulated: boolean;
  };
  readonly simulator: {
    readonly controls: SimulatorControls;
    readonly calls: SimulatorCallLog;
  } | undefined;
  readonly administration: Administration;
  private readonly store: Store;
  private readonly commands: CommandService;
  private readonly queries: QueryService;
  private readonly worker: OrchestrationWorker;
  private readonly bridge: BridgeQueries;
  private readonly simulators: Simulators | undefined;
  private readonly references: ReferenceRepository;
  private readonly externalCapture: ExternalCaptureService;
  private readonly eventLog: EventRepository;
  private readonly handoffService: HandoffService;

  constructor(path: string, options: HubOptions = {}) {
    this.store = options.clock === undefined ? new Store(path) : new Store(path, options.clock);
    this.references = new ReferenceRepository(this.store);
    this.externalCapture = new ExternalCaptureService(this.store);
    this.eventLog = new EventRepository(this.store.database);
    const runtime = createHubRuntime(path, this.store, options);
    this.administration = runtime.administration; this.commands = runtime.commands;
    this.queries = runtime.queries; this.worker = runtime.worker; this.bridge = runtime.bridge;
    this.simulators = runtime.simulators; this.handoffService = runtime.handoffService;
    this.readiness = { coreReady: false, liveIntegrationReady: false, simulated: runtime.useSimulator };
    this.simulator = runtime.simulators === undefined ? undefined
      : { controls: runtime.simulators.controls, calls: runtime.simulators.calls };
  }

  async execute(actor: Actor, input: unknown): Promise<HubCommandReceipt> {
    const admin = this.tryAdminCommand(input);
    if (admin !== undefined) {
      return this.commands.execute(actor, admin.command);
    }
    return this.commands.execute(actor, parseHubCommand(input));
  }

  actorForUser(id: string): Actor | undefined { return this.administration.users.actorForUser(id); }

  getTask(actor: Actor, id: string) { return this.queries.getTask(actor, id); }
  getReference(actor: Actor, id: string) { return this.references.get(actor, id); }
  captureExternalReference(actor: Actor, input: ExternalCapture): ReturnType<ExternalCaptureService['capture']>;
  captureExternalReference(actor: Actor, input: ExternalCaptureSelection): ReturnType<ExternalCaptureService['preflight']>;
  captureExternalReference(actor: Actor, input: ExternalCaptureRequest) {
    return 'retainedText' in input ? this.externalCapture.capture(actor, input) : this.externalCapture.preflight(actor, input);
  }
  listTasks(actor: Actor, query: TaskListQuery = {}) { return this.queries.listTasks(actor, query); }
  getRequest(actor: Actor, id: string) { return this.queries.getRequest(actor, id); }
  getSession(actor: Actor, id: string) { return this.queries.getSession(actor, id); }
  getOutput(actor: Actor, id: string, query: { readonly attemptId?: string; readonly after: number; readonly limit: number }) { return this.queries.getOutput(actor, id, query); }
  getOperation(actor: Actor, id: string) { return this.queries.getOperation(actor, id); }
  getEnvironmentRegistration(actor: Actor, id: string) {
    return this.queries.getEnvironmentRegistration(actor, id);
  }
  getEnvironmentBinding(actor: Actor, id: string) { return this.queries.getEnvironmentBinding(actor, id); }
  getCommandReceipt(actor: Actor, id: string) { return this.queries.getCommandReceipt(actor, id); }
  registerProjectRepository(actor: Actor, input: RegisterRepositoryRequest) { return this.handoffService.registerRepository(actor, input); }
  listProjectRepositories(actor: Actor, projectId: string) { return this.handoffService.listRepositories(actor, projectId); }
  previewHandoff(actor: Actor, input: HandoffPreviewRequest) { return this.handoffService.preview(actor, input); }
  getHandoff(actor: Actor, attemptId: string) {
    const handoff = this.handoffService.get(actor, attemptId);
    return { ...handoff,
      results: this.snapshot(actor).results.filter((result) => result.attemptId === attemptId) };
  }
  listHandoffs(actor: Actor, taskId: string) {
    return this.handoffService.list(actor, taskId).map((handoff) => ({ ...handoff,
      results: this.snapshot(actor).results.filter((result) => result.attemptId === handoff.attempt.id) }));
  }
  recipientAssignment(input: RecipientAssignmentRequest) { return this.handoffService.assignment(input); }
  acknowledgeAttemptDelivery(actor: Actor, input: {
    readonly attemptId: string;
    readonly deliveryDigest: string;
  }): void {
    this.handoffService.acknowledge(actor, input);
  }
  getDashboard(actor: Actor) { return this.queries.dashboard(actor); }
  contextSnapshot(actor: Actor, input: ContextQuery) { return this.queries.context(actor, input); }
  events(actor: Actor, input: { readonly after: number; readonly limit?: number }) {
    const snapshot = this.snapshot(actor);
    const permittedIds = new Set([...snapshot.tasks, ...snapshot.requests, ...snapshot.sessions, ...snapshot.attempts, ...snapshot.environmentBindings, ...snapshot.environmentRegistrations, ...snapshot.results].map((record) => record.id));
    return this.eventLog.list(actor, { after: input.after, limit: Math.max(1, Math.min(input.limit ?? 100, 100)), permittedIds });
  }
  snapshot(actor: Actor): HubSnapshot { return this.queries.snapshot(actor); }

  agentRequests(actor: Actor) { return this.bridge.requests(actor); }
  assertBridgeScope(scope: RuntimeScope): void {
    this.bridge.assertScope(scope);
    this.handoffService.assertScope(scope);
  }
  bridgeResponses(actor: Actor, input: { readonly after?: string } = {}) { return this.bridge.responses(actor, input); }

  drain(input: { readonly limit?: number } = {}): Promise<number> { return this.worker.drain(input); }
  reconcile(input: { readonly limit?: number } = {}): Promise<number> { return this.worker.reconcile(input); }

  exportRecords(actor: Actor): string {
    return JSON.stringify(exportSafeRecords({ contractVersion: "work-hub-export.v1", exportedAt: this.store.clock.now().toISOString(),
      workspaceId: actor.workspaceId, records: this.snapshot(actor) }));
  }

  close(): void {
    this.simulators?.close();
    this.store.close();
  }

  private tryAdminCommand(input: unknown) {
    const parsed = adminCommandSchema.safeParse(input);
    return parsed.success ? { command: parsed.data } : undefined;
  }
}
