import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { PromptEnvelopeSchema } from '../../application/prompts/index.ts';
import { createTask, delegateNone, fixture, member } from '../acceptance-fixture.ts';

test('normal delegation persists one versioned task brief with exact attempt criteria context and target selection', async () => {
  const f = fixture();
  try {
    const taskId = await createTask(f.hub, 'prompt-core-delivery');
    await f.hub.execute(member, { commandId: 'prompt-core-amend', type: 'task.amend',
      target: { kind: 'task', id: taskId }, expected: { task: 1 }, payload: {
        summary: 'Retain exact verification criterion.', supersedesCriterionIds: [], criteria: [{
          key: 'exact-source', description: 'Verify the retained source.', requirement: 'required', verification: 'required',
        }],
      } });
    const attempt = await delegateNone(f.hub, taskId, 'prompt-core-delivery');
    const envelope = PromptEnvelopeSchema.parse(JSON.parse(z.string().parse(attempt.inputSnapshot['instruction'])));

    assert.deepEqual(envelope.template, { id: 'task_brief', version: 1 });
    assert.equal(envelope.input['attemptId'], attempt.id);
    assert.equal(z.object({ id: z.string() }).parse(envelope.input['task']).id, taskId);
    assert.equal(z.object({ environment: z.object({ mode: z.string() }) }).parse(envelope.input['execution']).environment.mode, 'none');
    assert.equal(z.array(z.unknown()).parse(envelope.input['criteria']).length, 1);
    assert.ok(z.array(z.unknown()).parse(envelope.input['context']).length > 0);
    const template = z.object({ id: z.string(), version: z.number(), inputDigest: z.string() })
      .optional().parse(attempt.inputSnapshot['promptTemplate']);
    assert.equal(template?.id, 'task_brief');
    assert.equal(template?.version, 1);
    assert.match(template?.inputDigest ?? '', /^sha256:[0-9a-f]{64}$/);
  } finally { f.close(); }
});
