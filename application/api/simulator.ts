import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Hub, Actor } from '../orchestration/hub.ts';
import { requireAdministrator } from '../domain/authorization.ts';
import { forbidden, unsupported } from '../domain/errors.ts';
import type { ApiEnvironment } from './security.ts';

const controlSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('question'), sessionId: z.string(), prompt: z.string().min(1).max(131072), route: z.enum(['native', 'bridge']).default('native'), blocking: z.enum(['none', 'runtime_action']).default('runtime_action') }),
  z.strictObject({ type: z.literal('result'), sessionId: z.string(), summary: z.string().min(1).max(131072) }),
  z.strictObject({ type: z.literal('termination'), sessionId: z.string(), outcome: z.enum(['completed', 'stopped', 'failed', 'unknown']) }),
  z.strictObject({ type: z.literal('output'), sessionId: z.string(), text: z.string().min(1).max(65536) }),
  z.strictObject({ type: z.literal('gap'), sessionId: z.string(), reason: z.string().min(1).max(512) }),
]);

export function simulatorRoutes(options: { readonly hub: Hub; readonly actor: (c: Context<ApiEnvironment>) => Actor }) {
  const { hub, actor } = options;
  const app = new Hono<ApiEnvironment>();
  app.post('/commands', async (c) => {
    const current = actor(c);
    requireAdministrator(current);
    const simulator = hub.simulator;
    if (!simulator) throw forbidden('No simulator installation is configured.');
    const control = controlSchema.parse(await c.req.json<unknown>());
    const shell = hub.getSession(current, control.sessionId);
    const session = shell.session;
    const attempt = shell.attempt;
    if (session.lifecycle !== 'open') throw forbidden('The selected simulated session is not open.');
    switch (control.type) {
      case 'question':
        if (!attempt) throw forbidden('A question must target an observed attempt.');
        if (z.object({ support: z.string() }).parse(session.capabilities[control.route === 'native' ? 'nativeQuestions' : 'requestBridge']).support !== 'supported') throw unsupported('question_route_unsupported', 'The selected runtime does not support this question delivery route.');
        simulator.controls.emitQuestion({ hubSessionId: session.id, hubAttemptId: attempt.id, requestId: `sim-question-${randomUUID()}`, projectId: session.projectId, taskId: session.taskId, recipient: { kind: 'user', userId: current.id }, bindingGeneration: session.bindingGeneration, prompt: control.prompt, responseRoute: control.route, blocking: control.blocking });
        break;
      case 'result':
        if (!attempt) throw forbidden('A result must target an attempt.');
        simulator.controls.emitResult({ hubSessionId: session.id, hubAttemptId: attempt.id, bindingGeneration: session.bindingGeneration, summary: control.summary, referenceIds: [] });
        break;
      case 'termination':
        if (!attempt) throw forbidden('A termination observation must target an attempt.');
        simulator.controls.emitTermination({ hubSessionId: session.id, hubAttemptId: attempt.id, bindingGeneration: session.bindingGeneration, termination: control.outcome });
        break;
      case 'output': simulator.controls.emitOutput(session.id, control.text); break;
      case 'gap': simulator.controls.addHistoryGap(session.id, control.reason); break;
      default: return assertNever(control);
    }
    await hub.reconcile();
    return c.json({ simulated: true, accepted: true, liveExecutionEvidence: false });
  });
  app.get('/calls', (c) => {
    requireAdministrator(actor(c));
    return c.json({ simulated: true, items: hub.simulator?.calls.list().slice(-200).map((call) => ({ sequence: call.sequence, operationKind: call.operationKind, operationId: call.operationId, recordedAt: call.recordedAt })) ?? [] });
  });
  return app;
}
function assertNever(value: never): never { throw new TypeError(`Unexpected simulator control ${String(value)}`); }
