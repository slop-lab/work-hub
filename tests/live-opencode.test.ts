import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { ConnectorLedger } from '../application/connectors/ledger.ts';
import { OpenCodeRuntimeConnector } from '../application/connectors/opencode/runtime.ts';
import { digest } from '../application/persistence/codec.ts';
import type { ActionContext, RuntimeEvent } from '../application/contracts/index.ts';
import { startNativeOpenCode } from './native-opencode.ts';

const model = process.env['WORK_HUB_LIVE_MODEL'];
const agent = process.env['WORK_HUB_LIVE_AGENT'];
test('actual OpenCode question, answer, result and restart continuity', { skip: !model || !agent, timeout: 240_000 }, async () => {
  assert.ok(model && agent);
  const separator = model.indexOf('/');
  assert.ok(separator > 0);
  const native = await startNativeOpenCode();
  const path = join(native.root, 'connector.sqlite');
  let ledger = new ConnectorLedger(path);
  let connector = new OpenCodeRuntimeConnector(ledger, native.connection);
  const context = (id: string): ActionContext => ({ workspaceId: 'acceptance', installationId: native.connection.installationId,
    correlationId: id, commandId: id, operationId: id, inputDigest: digest(id), authorizedGrantRefs: ['opencode:logical-live'] });
  try {
    const inventory = await native.client.discover(context('discover'));
    assert.ok(inventory.agents.includes(agent));
    const opened = await connector.openSession(context('open'), { hubSessionId: 'logical-live', mode: 'create',
      sessionLaunchOwner: 'runtime_connector', requestedControl: 'control', configuration: { agent,
        model: { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }, projectId: 'project-default' },
      route: { kind: 'external', route: { id: 'saved', ownerInstallationId: native.connection.installationId, kind: 'http' } } });
    assert.ok(opened.status === 'confirmed', JSON.stringify(opened));
    const target = { hubSessionId: 'logical-live', hubAttemptId: 'attempt-live', nativeSession: opened.result.nativeSession,
      bindingGeneration: 1, controlGrantRef: opened.result.controlGrant.id };
    const start = await connector.startAttempt(context('start'), { target, workAreas: [], input: {
      id: 'snapshot', digest: digest('input'), taskId: 'task-live', taskRevision: 1, profileId: 'live-profile', profileRevision: 1,
      instruction: 'Disposable connector acceptance only. Use the native question tool to ask exactly one free-text question: Which acceptance marker? Wait for its answer, then return a short receipt that identifies the answer. Do not delegate, use other tools, run shell commands or change files.',
      selectedReferenceIds: [], selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [], assembledAt: new Date().toISOString(),
    } });
    assert.ok(start.status === 'confirmed' || start.status === 'unknown');
    ledger.close();
    ledger = new ConnectorLedger(path);
    connector = new OpenCodeRuntimeConnector(ledger, native.connection);
    let question: Extract<RuntimeEvent['payload'], { type: 'request.created' }> | undefined;
    for (let index = 0; index < 90 && !question; index++) {
      for await (const event of connector.subscribe(context('observe'), { target })) {
        if (event.payload.type === 'request.created') question = event.payload;
      }
      if (!question) await delay(1000);
    }
    assert.ok(question, 'Actual runtime did not publish a supported question within 90 seconds.');
    const waiting = await connector.inspectSession(context('waiting'), target);
    assert.equal(waiting.value.execution.phase, 'waiting_input');
    const response = await connector.deliverResponse(context('answer'), { target, requestId: 'question-live', requestRevision: 1,
      responseId: 'answer-live', responseDigest: digest('marker'), nativeRequestRef: question.request.nativeRequestRef,
      validity: question.request.draft.validity, answer: { kind: 'text', text: 'native-connector-acceptance' } });
    assert.equal(response.status, 'confirmed');
    let result = false;
    for (let index = 0; index < 90 && !result; index++) {
      for await (const event of connector.subscribe(context('result'), { target })) {
        if (event.payload.type === 'result.submitted') result = true;
      }
      if (!result) await delay(1000);
    }
    assert.ok(result, 'Actual runtime did not publish a final assistant result within 90 seconds.');
    assert.equal((await connector.inspectSession(context('ended'), target)).value.execution.termination, 'completed');
    const output = await connector.readOutput(context('transcript'), { target, limit: 100 });
    assert.ok(output.items.some((item) => item.role === 'agent'));
    assert.ok(output.items.some((item) => item.role === 'user'));
    console.log(JSON.stringify({ service: 'actual-opencode', version: inventory.version, model, agent,
      nativeSession: target.nativeSession.id, question: 'answered', result: 'received', restart: 'same-native-binding', outputItems: output.items.length }));
  } finally { ledger.close(); await native.close(); }
});
