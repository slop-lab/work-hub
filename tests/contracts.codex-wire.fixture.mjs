#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.164.0\n');
  process.exit(0);
}

const methods = [];
let threadReadCount = 0;
const turns = [];
let pendingQuestionRequestId;
const thread = () => ({ id: '01900000-0000-7000-8000-000000000001', sessionId: '01900000-0000-7000-8000-000000000001',
  ephemeral: false, cwd: process.cwd(), modelProvider: 'openai', model: 'fixture', cliVersion: '0.164.0',
  status: { type: turns.some((turn) => turn.status === 'inProgress') ? 'active' : 'idle', activeFlags: [] },
  createdAt: 1, updatedAt: 1, turns });
process.on('SIGTERM', () => {
  writeFileSync(join(process.env.CODEX_HOME, 'sigterm-observed'), 'yes');
  process.exit(0);
});
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === 'fixture-question' && message.result !== undefined) {
    process.stdout.write(`${JSON.stringify({ id: pendingQuestionRequestId, result: message.result })}\n`);
    pendingQuestionRequestId = undefined;
    continue;
  }
  methods.push(message.method);
  if (message.id === undefined) continue;
  if (message.method === 'initialize') process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } })}\n`);
  else if (message.method === 'model/list') process.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`);
  else if (message.method === 'test/provider-error') process.stdout.write(`${JSON.stringify({ id: message.id,
    error: { code: 4321, message: 'private-upstream-provider-detail' } })}\n`);
  else if (message.method === 'test/oversized-line') process.stdout.write('x'.repeat(2 * 1024 * 1024));
  else if (message.method === 'test/notifications') {
    for (let index = 0; index < 400; index += 1) process.stdout.write(`${JSON.stringify({ method: 'test/event', params: { index } })}\n`);
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  }
  else if (message.method === 'test/lifecycle-notifications') {
    process.stdout.write(`${JSON.stringify({ method: 'error', params: { threadId: message.params.threadId,
      turnId: message.params.turnId, willRetry: true, error: { message: 'retry', codexErrorInfo: 'serverOverloaded',
        additionalDetails: null, misalignment: null } } })}\n`);
    process.stdout.write(`${JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: {
      limitId: 'codex', limitName: 'Codex', normalModelSlug: 'fixture', primary: { usedPercent: 75,
        windowDurationMins: 300, resetsAt: 120 }, secondary: null, credits: null, individualLimit: null,
      spendControlReached: null, planType: null, rateLimitReachedType: null } } })}\n`);
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  }
  else if (message.method === 'test/server-question') {
    pendingQuestionRequestId = message.id;
    process.stdout.write(`${JSON.stringify({ id: 'fixture-question', method: 'item/tool/requestUserInput', params: {
      threadId: message.params.threadId, turnId: message.params.turnId, itemId: 'question-item', isBlocking: true,
      autoResolutionMs: null, questions: [{ id: 'question-1', header: 'Choice', question: 'Pick one',
        isOther: false, isSecret: false, options: [{ label: 'Alpha', description: 'First' }] }],
    } })}\n`);
  }
  else if (message.method === 'test/exit') process.exit(7);
  else if (message.method === 'turn/start') {
    const turn = { id: '01900000-0000-7000-8000-000000000002', status: 'inProgress', startedAt: 2, completedAt: null,
      error: null, items: [{ type: 'userMessage', id: 'user-1', clientId: message.params.clientUserMessageId, content: message.params.input }] };
    turns.push(turn);
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { turn } })}\n`);
  } else if (message.method === 'test/add-unknown-turn') {
    turns.push({ id: '01900000-0000-7000-8000-000000000003', status: 'inProgress', startedAt: 2, completedAt: null,
      error: null, items: [{ type: 'userMessage', id: 'user-unknown', clientId: message.params.clientId,
        content: [{ type: 'text', text: 'unknown', text_elements: [] }] }] });
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  } else if (message.method === 'thread/read') {
    threadReadCount += 1;
    if (existsSync(join(process.env.CODEX_HOME, 'complete-turns'))) for (const turn of turns) {
      turn.status = 'completed'; turn.completedAt = 3;
    }
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: thread() } })}\n`);
  }
  else if (message.method === 'test/state') process.stdout.write(`${JSON.stringify({ id: message.id, result: {
    methods, environmentKeys: Object.keys(process.env).sort(), cwd: process.cwd(), codexHome: process.env.CODEX_HOME, threadReadCount,
  } })}\n`);
  else process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'unknown' } })}\n`);
}
