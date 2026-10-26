import { z } from 'zod';
import type { Actor } from '../domain/authorization.ts';
import type { HubSnapshot, RequestView } from '../domain/model.ts';
import type { Administration } from '../administration/index.ts';
import { presentHistory } from './history.ts';

const capabilitySchema = z.object({
  activeInputModes: z.array(z.enum(['immediate', 'runtime_queued'])).default([]),
  stopModes: z.array(z.string()).default([]),
  continueNativeSession: z.object({ support: z.string() }).optional(),
  nativeQuestions: z.object({ support: z.string() }).optional(),
  requestBridge: z.object({ support: z.string() }).optional(),
});
const identitySchema = z.object({ assurance: z.enum(['immutable', 'attested', 'weak']), native: z.object({ id: z.string(), incarnation: z.string().optional() }) });
const outputSchema = z.object({ id: z.string(), sessionId: z.string(), attemptId: z.string().optional(), kind: z.enum(['message', 'log', 'status_note', 'reference', 'gap']), role: z.enum(['user', 'agent', 'runtime']).optional(), text: z.string().optional(), partial: z.boolean().optional(), observedAt: z.string() });
export type PresentationInput = {
  readonly snapshot: HubSnapshot;
  readonly actor: Actor;
  readonly administration: Administration;
  readonly output?: readonly z.infer<typeof outputSchema>[];
  readonly simulated?: boolean;
};

export function presentUser(actor: Actor, administration: Administration) {
  const user = administration.users.list(actor).find((item) => item.id === actor.id);
  return { id: actor.id, displayName: user?.displayName ?? actor.id, role: actor.role === 'administrator' ? 'admin' as const : 'member' as const, enabled: user?.enabled ?? true };
}
export function presentTask(task: HubSnapshot['tasks'][number]) {
  return { ...task, priority: task.priority === undefined ? 'medium' : task.priority <= 10 ? 'urgent' : task.priority <= 30 ? 'high' : task.priority <= 60 ? 'medium' : 'low' };
}
export function presentState({ snapshot, actor, administration, output = [], simulated = true }: PresentationInput) {
  const history = presentHistory(snapshot);
  const taskTitle = (id: string | undefined) => snapshot.tasks.find((task) => task.id === id)?.title ?? 'Project inbox';
  const attentionRequest = (request: RequestView) => ({
    key: `${request.kind}:${request.id}:${request.revision}`,
    kind: request.kind === 'approval' ? 'approval_needed' : 'answer_needed',
    title: request.prompt, context: request.reason ?? taskTitle(request.taskId),
    ...(request.taskId ? { taskId: request.taskId } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    requestId: request.id, freshness: 'fresh' as const, reasonCode: request.blocking,
    availableActions: ['request.respond'],
  });
  const sessions = snapshot.sessions.map((session) => {
    const parsed = capabilitySchema.safeParse(session.capabilities);
    const capability: z.infer<typeof capabilitySchema> = parsed.success ? parsed.data : { activeInputModes: [], stopModes: [] };
    const attempt = snapshot.attempts.find((item) => item.sessionId === session.id);
    const profile = snapshot.profiles.find((item) => item.id === attempt?.profileId);
    return { ...session, state: session.lifecycle, runtimeLabel: profile?.label ?? session.runtimeInstallationId,
      ...(profile ? { profileId: profile.id } : {}),
      capabilities: { instructionModes: capability.activeInputModes, stopModes: capability.stopModes, canContinue: capability.continueNativeSession?.support === 'supported', nativeQuestionSupport: capability.nativeQuestions?.support === 'supported', bridgeQuestionSupport: capability.requestBridge?.support === 'supported' },
      limitations: [administration.installations.list(actor).find((item) => item.id === session.runtimeInstallationId)?.simulator
        ? 'Simulated connection. No real agent or infrastructure is connected.'
        : 'External connection. HTTP acceptance is not proof of execution. Native clients may also control this session.',
        ...(session.controlMode === 'observe' ? ['View only: no instruction or stop authority.'] : []), ...(session.runtimeInstallationId === 'runtime-sim-limited' ? ['Limited bridge profile: no immediate steering or native approvals.'] : [])],
    };
  });
  const bindings = snapshot.environmentBindings.map((binding) => {
    const identity = identitySchema.safeParse(binding.identity);
    const enforcement = z.enum(['enforced', 'advisory', 'unknown']).safeParse(binding.useGrant?.['enforcement']);
    const unresolved = snapshot.attempts.some((attempt) => attempt.sessionId === binding.sessionId && attempt.unresolved && attempt.role === 'primary');
    const canControl = actor.role === 'administrator' || actor.bindingIds.includes(binding.id);
    return { ...binding, origin: binding.sourceKind === 'allocation' ? 'allocated' as const : 'registered_existing' as const,
      identityLabel: identity.success ? `${identity.data.native.id} / ${identity.data.native.incarnation ?? 'unknown incarnation'}` : 'Identity not yet verified',
      access: binding.accessMode, enforcement: enforcement.success ? enforcement.data : 'unknown' as const,
      canDetach: canControl && !unresolved && binding.state === 'attached',
      canRelease: canControl && !unresolved && binding.sourceKind === 'allocation' && binding.lifecycleGrant !== undefined && binding.state !== 'released',
      limitations: ['Hub-only reservations do not exclude external writers.', ...(binding.sourceKind === 'registration' ? ['Attach only. Detach preserves contents and lifecycle.'] : ['Release applies the recorded provider policy; it does not necessarily delete.'])],
    };
  });
  const active = snapshot.dashboard.activeAttempts;
  const review = snapshot.results.filter((result) => snapshot.tasks.some((task) => task.id === result.taskId && !['done', 'canceled'].includes(task.status)));
  return {
    snapshotCursor: snapshot.dashboard.snapshotCursor, generatedAt: new Date().toISOString(), simulator: simulated,
    limitations: [simulated ? 'Simulation only. Core conformance is not live-provider compatibility.' : 'External adapters configured. Full cross-service acceptance is not established by configuration.'], me: presentUser(actor, administration),
    projects: administration.projects.list(actor),
    users: administration.users.list(actor).map((user) => ({ id: user.id, displayName: user.displayName, role: user.role === 'administrator' ? 'admin' : 'member', enabled: user.enabled, revision: user.revision, ...(actor.role === 'administrator' ? { projectIds: user.projectIds, profileIds: user.profileIds, bindingIds: user.bindingIds } : {}) })),
    installations: administration.installations.list(actor),
    userViewState: administration.views.list(actor),
    tasks: snapshot.tasks.map(presentTask),
    requests: snapshot.requests.map((request) => {
      const delivery = (snapshot.deliveries ?? []).find((item) => item['requestId'] === request.id);
      const status = z.enum(['not_required', 'pending', 'acknowledged', 'rejected', 'unknown', 'suppressed']).safeParse(delivery?.['status']);
      return { ...request, ...(request.responseRoute === 'none' ? { deliveryStatus: 'not_required' } : request.status === 'answered' ? { deliveryStatus: status.success ? status.data : 'unknown' } : {}) };
    }), sessions, attempts: snapshot.attempts,
    results: snapshot.results.map((result) => ({ ...result, submittedAt: result.createdAt })),
    environments: snapshot.environmentRegistrations.map((registration) => {
      const identity = identitySchema.safeParse(registration.verifiedIdentity);
      return { ...registration, workAreas: registration.allowedWorkAreas,
        ...(identity.success ? { identityAssurance: identity.data.assurance } : {}),
        limitations: ['Existing contents and lifecycle are preserved.', ...(identity.success && identity.data.assurance === 'weak' ? ['Weak identity requires explicit fresh confirmation for mutation.'] : [])],
      };
    }),
    environmentBindings: bindings,
    profiles: snapshot.profiles.map((profile) => ({ ...profile, defaultEnvironmentMode: profile.defaultEnvironment['mode'], simulator: administration.installations.list(actor).find((installation) => installation.id === profile.runtimeInstallationId)?.simulator ?? false, limitations: [administration.installations.list(actor).find((installation) => installation.id === profile.runtimeInstallationId)?.simulator ? 'Deterministic simulator, not real-service evidence.' : 'Configured external adapter; inspect its reported capabilities and limitations.', ...(profile.runtimeInstallationId === 'runtime-sim-limited' ? ['Limited bridge interaction; unsupported controls are refused.'] : [])] })),
    attention: {
      answerNeeded: snapshot.dashboard.answerNeeded.map(attentionRequest),
      approvalNeeded: snapshot.dashboard.approvalNeeded.map(attentionRequest),
      responseDelivery: snapshot.dashboard.deliveryProblems.map((problem, index) => ({ key: `delivery:${String(problem['id'] ?? index)}`, kind: 'response_delivery', title: 'Answer saved; delivery needs attention', context: String(problem['status'] ?? 'unknown'), freshness: 'unknown', reasonCode: 'response_delivery_unconfirmed',
        observedAt: String(problem['updatedAt'] ?? new Date().toISOString()), availableActions: ['operation.reconcile'], ...(typeof problem['requestId'] === 'string' ? { requestId: problem['requestId'] } : {}), ...(typeof problem['operationId'] === 'string' ? { operationId: problem['operationId'] } : {}) })),
      activeWork: active.map((attempt) => ({ key: `attempt:${attempt.id}:${attempt.updatedAt}`, kind: 'active_work', title: taskTitle(attempt.taskId), context: `${attempt.phase}; observation ${attempt.observation}`, taskId: attempt.taskId, sessionId: attempt.sessionId, freshness: attempt.observation, reasonCode: attempt.phase, observedAt: attempt.updatedAt, availableActions: attempt.role === 'primary' ? ['session.instruct', 'attempt.stop'] : [] })),
      resultReview: review.map((result) => ({ key: `result:${result.id}`, kind: 'result_review', title: taskTitle(result.taskId), context: result.summary, taskId: result.taskId, resultId: result.id, freshness: 'fresh', reasonCode: 'result_submitted', availableActions: ['task.setStatus', 'task.requestRevision'] })),
      operationalIssues: snapshot.dashboard.operationalIssues.map((issue, index) => {
        const operation = presentHistory(snapshot).operations.find((candidate) => candidate.id === issue['id']);
        return { key: `issue:${String(issue['id'] ?? index)}`, kind: 'operational_issue', title: operation?.error?.message ?? 'Connection needs attention', context: `${String(issue['operationKind'] ?? 'External operation')} at ${String(issue['stage'] ?? 'unknown stage')}`, freshness: 'unknown' as const,
          reasonCode: operation?.error?.code ?? 'observation_unknown', observedAt: operation?.observedAt ?? String(issue['updatedAt'] ?? new Date().toISOString()), availableActions: ['operation.reconcile'], ...(typeof issue['id'] === 'string' ? { operationId: issue['id'] } : {}) };
      }),
    },
    ...history,
    output: [...history.output, ...output],
  };
}

export type ContextRoute = { readonly route: 'dashboard' | 'backlog' | 'task' | 'session' | 'environments' | 'settings' | 'operation' | 'showcase'; readonly id?: string };

export function presentContext(input: PresentationInput, context: ContextRoute) {
  const snapshot = input.snapshot;
  const dashboard = context.route === 'dashboard' ? {
    ...snapshot.dashboard,
    answerNeeded: snapshot.dashboard.answerNeeded.slice(0, 50),
    approvalNeeded: snapshot.dashboard.approvalNeeded.slice(0, 50),
    deliveryProblems: snapshot.dashboard.deliveryProblems.slice(0, 50),
    activeAttempts: snapshot.dashboard.activeAttempts.slice(0, 50),
    resultsToReview: snapshot.dashboard.resultsToReview.slice(0, 50),
    operationalIssues: snapshot.dashboard.operationalIssues.slice(0, 50),
  } : snapshot.dashboard;
  const taskIds = new Set<string>();
  const sessionIds = new Set<string>();
  const attemptIds = new Set<string>();
  if (context.route === 'task' && context.id !== undefined) taskIds.add(context.id);
  if (context.route === 'session') {
    const sessionId = context.id ?? snapshot.sessions[0]?.id;
    if (sessionId !== undefined) sessionIds.add(sessionId);
  }
  if (context.route === 'dashboard') {
    for (const request of [...dashboard.answerNeeded, ...dashboard.approvalNeeded]) if (request.taskId !== undefined) taskIds.add(request.taskId);
    for (const attempt of dashboard.activeAttempts) { taskIds.add(attempt.taskId); sessionIds.add(attempt.sessionId); attemptIds.add(attempt.id); }
    for (const result of dashboard.resultsToReview) {
      if (typeof result['taskId'] === 'string') taskIds.add(result['taskId']);
      if (typeof result['attemptId'] === 'string') attemptIds.add(result['attemptId']);
    }
  }
  for (const session of snapshot.sessions) if (sessionIds.has(session.id) || taskIds.has(session.taskId)) { sessionIds.add(session.id); taskIds.add(session.taskId); }
  for (const attempt of snapshot.attempts) if (attemptIds.has(attempt.id) || sessionIds.has(attempt.sessionId) || taskIds.has(attempt.taskId)) { attemptIds.add(attempt.id); sessionIds.add(attempt.sessionId); taskIds.add(attempt.taskId); }
  const requestIds = new Set(snapshot.requests.filter((request) => (request.taskId !== undefined && taskIds.has(request.taskId)) || (request.sessionId !== undefined && sessionIds.has(request.sessionId)) || (request.attemptId !== undefined && attemptIds.has(request.attemptId))).map((request) => request.id));
  if (context.route === 'dashboard') for (const request of [...dashboard.answerNeeded, ...dashboard.approvalNeeded]) requestIds.add(request.id);
  const scoped: HubSnapshot = { ...snapshot, dashboard, tasks: snapshot.tasks.filter((task) => taskIds.has(task.id)), sessions: snapshot.sessions.filter((session) => sessionIds.has(session.id)), attempts: snapshot.attempts.filter((attempt) => attemptIds.has(attempt.id)), requests: snapshot.requests.filter((request) => requestIds.has(request.id)), results: snapshot.results.filter((result) => taskIds.has(result.taskId) || attemptIds.has(result.attemptId)),
    entries: (snapshot.entries ?? []).filter((entry) => typeof entry['taskId'] === 'string' && taskIds.has(entry['taskId'])), responses: (snapshot.responses ?? []).filter((response) => typeof response['requestId'] === 'string' && requestIds.has(response['requestId'])), references: (snapshot.references ?? []).filter((reference) => typeof reference['taskId'] === 'string' && taskIds.has(reference['taskId'])),
    environmentBindings: context.route === 'environments' ? snapshot.environmentBindings : snapshot.environmentBindings.filter((binding) => sessionIds.has(binding.sessionId)), output: [], operations: (snapshot.operations ?? []).filter((operation) => context.route === 'operation' ? operation['id'] === context.id : context.route === 'dashboard' && ['unknown', 'failed', 'rejected'].includes(String(operation['status']))).slice(0, 50) };
  return presentState({ ...input, snapshot: scoped });
}
