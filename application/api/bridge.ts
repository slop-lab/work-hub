import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Hub, Actor } from '../orchestration/hub.ts';
import { forbidden } from '../domain/errors.ts';
import type { ApiEnvironment } from './security.ts';
import { commandEnvelope } from './command-envelope.ts';

function runtimeScope(context: Context<ApiEnvironment>) {
  const identity = context.get('identity');
  if (identity.kind !== 'bridge' || !identity.scope) throw forbidden('A scoped runtime principal is required.');
  return identity.scope;
}
function runtimeActor(context: Context<ApiEnvironment>): Actor {
  const scope = runtimeScope(context);
  return { id: scope.userId, role: 'runtime', workspaceId: scope.workspaceId, projectIds: [scope.projectId], profileIds: [], bindingIds: [], sessionId: scope.sessionId, attemptId: scope.attemptId, bindingGeneration: scope.bindingGeneration, allowedCommandTypes: scope.allowedCommands };
}

export function bridgeRoutes(hub: Hub) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (c, next) => {
    hub.assertBridgeScope(runtimeScope(c));
    await next();
  });
  app.post('/commands', async (c) => {
    const scope = runtimeScope(c);
    const command = commandEnvelope.parse(await c.req.json<unknown>());
    if (!scope.allowedCommands.some((type) => type === command.type)) throw forbidden('This bridge token does not permit that command.');
    if (command.type === 'request.respond') {
      if (command.target?.kind !== 'request') throw forbidden('An answer must identify its scoped request.');
      const request = hub.getRequest(runtimeActor(c), command.target.id);
      if (request.recipient['kind'] !== 'agent_session' || request.recipient['sessionId'] !== scope.sessionId || request.sessionId !== scope.sessionId || request.attemptId !== scope.attemptId || request.bindingGeneration !== scope.bindingGeneration) throw forbidden('This request is outside the recipient credential scope.');
    } else if (command.target && (command.target.kind !== 'attempt' || command.target.id !== scope.attemptId)) throw forbidden('Bridge commands cannot select another target.');
    const fields = { projectId: scope.projectId, taskId: scope.taskId, sessionId: scope.sessionId, attemptId: scope.attemptId, bindingGeneration: scope.bindingGeneration };
    for (const [field, expected] of Object.entries(fields)) {
      const provided = command.payload[field];
      if (provided !== undefined && provided !== expected) throw forbidden('The command context differs from the credential scope.');
    }
    if (command.type === 'request.create') {
      if (command.payload['projectId'] !== scope.projectId || command.payload['taskId'] !== scope.taskId || command.payload['sessionId'] !== scope.sessionId || command.payload['attemptId'] !== scope.attemptId || command.payload['bindingGeneration'] !== scope.bindingGeneration) throw forbidden('Runtime questions must include their exact authenticated context.');
    }
    if (command.type === 'result.submit' && !command.target) throw forbidden('A result must identify the authenticated attempt.');
    const receipt = await hub.execute(runtimeActor(c), command);
    return c.json(receipt, receipt.status === 'rejected' ? receipt.error?.category === 'authorization' ? 403 : 409 : receipt.status === 'accepted' ? 202 : 200);
  });
  app.get('/requests', (c) => {
    const scope = runtimeScope(c);
    const requests = hub.agentRequests(runtimeActor(c));
    return c.json({ items: requests, bindingGeneration: scope.bindingGeneration });
  });
  app.get('/requests/:id', (c) => {
    const scope = runtimeScope(c);
    const request = hub.getRequest(runtimeActor(c), c.req.param('id'));
    if (request.sessionId !== scope.sessionId || request.attemptId !== scope.attemptId || request.bindingGeneration !== scope.bindingGeneration) throw forbidden('The request is outside this runtime scope.');
    const responses = hub.bridgeResponses(runtimeActor(c));
    return c.json({ ...request, responses: responses.items.filter((item) => item['requestId'] === request.id) });
  });
  app.get('/responses', (c) => {
    const after = z.string().max(2048).optional().parse(c.req.query('after'));
    return c.json(hub.bridgeResponses(runtimeActor(c), after ? { after } : {}));
  });
  app.post('/responses/:id/ack', async (c) => {
    const scope = runtimeScope(c);
    if (!scope.allowedCommands.includes('bridge.response.ack')) throw forbidden('Acknowledgment is not granted by this bridge token.');
    const input = z.strictObject({ commandId: z.string().min(1).max(200), responseDigest: z.string().min(1).max(512), bindingGeneration: z.number().int().positive() }).parse(await c.req.json<unknown>());
    if (input.bindingGeneration !== scope.bindingGeneration) throw forbidden('Acknowledgment generation differs from credential scope.');
    const receipt = await hub.execute(runtimeActor(c), { commandId: input.commandId, type: 'bridge.response.ack', payload: { responseId: c.req.param('id'), responseDigest: input.responseDigest, bindingGeneration: input.bindingGeneration } });
    return c.json(receipt, receipt.status === 'rejected' ? 409 : 200);
  });
  app.get('/events', (c) => {
    const after = z.string().max(2048).optional().parse(c.req.query('after'));
    return c.json({ ...hub.bridgeResponses(runtimeActor(c), after ? { after } : {}), contractMajor: 1, deliveryAcknowledgmentRequired: true });
  });
  return app;
}
