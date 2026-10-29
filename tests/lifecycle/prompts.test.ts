import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { PromptEnvelopeSchema, promptRegistry, renderPrompt, templateIds } from '../../application/prompts/index.ts';
import { digest } from '../../application/persistence/codec.ts';

const criteria = [
  { id: 'criterion-1', taskId: 'task-1', amendmentId: 'amendment-1', key: 'question-answered',
    description: 'Question is answered', requirement: 'required' as const, verification: 'optional' as const,
    createdAt: new Date(0).toISOString() },
  { id: 'criterion-2', taskId: 'task-1', amendmentId: 'amendment-1', key: 'native-verification',
    description: 'Native verification passes', requirement: 'required' as const, verification: 'required' as const,
    createdAt: new Date(0).toISOString() },
];
const amendments = [{ id: 'amendment-1', taskId: 'task-1', revision: 1, authorId: 'user-1',
  summary: 'Initial scope', criteria, supersedesCriterionIds: [], createdAt: new Date(0).toISOString() }];
const task = { id: 'task-1', revision: 2, scopeRevision: 1, title: 'Sanitized task',
  description: 'Complete the scoped work.' };

test('registry exposes every versioned lifecycle template', () => {
  assert.deepEqual(templateIds, [
    'task_brief', 'status_result', 'question_block', 'answer_continuation', 'verifier_handoff', 'fix_incomplete',
  ]);
  assert.deepEqual(Object.fromEntries(templateIds.map((id) => [id, promptRegistry[id].version])), {
    task_brief: 1, status_result: 1, question_block: 1, answer_continuation: 1, verifier_handoff: 1, fix_incomplete: 1,
  });
});

test('task brief renders a canonical envelope with structured lifecycle channels', () => {
  const rendered = renderPrompt('task_brief', {
    task, attemptId: 'attempt-1', instruction: 'Complete only the retained scope.',
    execution: { profileId: 'profile-1', profileRevision: 1, runtimeInstallationId: 'runtime-1',
      environment: { mode: 'none' } }, amendments, criteria,
    context: [{ id: 'context-1', text: 'Use the disposable fixture only.' }],
  });
  const envelope = PromptEnvelopeSchema.parse(JSON.parse(rendered.text));

  assert.equal(rendered.templateId, 'task_brief');
  assert.equal(rendered.version, 1);
  assert.equal(rendered.digest, digest(rendered.text));
  assert.equal(rendered.inputDigest, digest(envelope.input));
  assert.deepEqual(envelope.output.channels, ['checkpoint', 'final', 'criteria', 'block']);
  assert.equal(envelope.authority.taskCompletion, 'human_only');
  assert.equal(z.array(z.object({ description: z.string() })).parse(envelope.input['criteria'])[0]?.description,
    'Question is answered');
  assert.equal(z.array(z.unknown()).parse(envelope.input['amendments']).length, 1);
});

test('status result distinguishes checkpoint from final structurally', () => {
  const checkpoint = renderPrompt('status_result', {
    taskId: 'task-1', attemptId: 'attempt-1', kind: 'checkpoint', summary: 'Work remains.',
    criterionEvidence: [{ criterionId: 'criterion-1', status: 'satisfied', detail: 'Answered.', referenceIds: [] },
      { criterionId: 'criterion-2', status: 'not_verified', detail: 'Pending.', referenceIds: [] }], referenceIds: [],
    source: { repositoryId: 'repository-1', repositoryRevision: 1, branch: 'work/fixture', commit: 'a'.repeat(40) },
    environment: { identity: 'workspace-uuid/incarnation-1', status: 'running' },
  }, { header: 'Trusted operator framing.' });
  const final = renderPrompt('status_result', {
    taskId: 'task-1', attemptId: 'attempt-1', kind: 'final', summary: 'Work is ready for review.',
    criterionEvidence: criteria.map((criterion) => ({ criterionId: criterion.id, status: 'satisfied' as const,
      detail: 'Verified.', referenceIds: [] })), referenceIds: [],
  });

  assert.equal(PromptEnvelopeSchema.parse(JSON.parse(checkpoint.text)).input['kind'], 'checkpoint');
  assert.equal(PromptEnvelopeSchema.parse(JSON.parse(checkpoint.text)).presentation?.header,
    'Trusted operator framing.');
  assert.equal(PromptEnvelopeSchema.parse(JSON.parse(final.text)).input['kind'], 'final');
  assert.equal(z.array(z.object({ status: z.string() })).parse(
    PromptEnvelopeSchema.parse(JSON.parse(checkpoint.text)).input['criterionEvidence'])[1]?.status, 'not_verified');
  assert.notEqual(checkpoint.digest, final.digest);
  assert.throws(() => renderPrompt('status_result', {
    taskId: 'task-1', attemptId: 'attempt-1', kind: 'checkpoint', summary: 'Work remains.',
    criterionEvidence: [], referenceIds: [],
  }, { header: 'x'.repeat(2001) }));
});

test('sanitized UCS clarification and block use typed requests without keyword inference', () => {
  const question = renderPrompt('question_block', {
    taskId: 'task-1', attemptId: 'attempt-1', requestId: 'request-1', kind: 'question',
    prompt: 'Which sanitized option?', pendingCriteria: [criteria[1]!],
  });
  const block = renderPrompt('question_block', {
    taskId: 'task-1', attemptId: 'attempt-1', requestId: 'request-2', kind: 'block',
    blocker: { id: 'blocker-1', taskId: 'task-1', attemptId: 'attempt-1', kind: 'external_dependency',
      owner: 'operator', remedy: 'Restore the dependency.', detail: 'External scope is unavailable.', status: 'open',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }, pendingCriteria: [criteria[1]!],
  });

  assert.equal(PromptEnvelopeSchema.parse(JSON.parse(question.text)).input['kind'], 'question');
  const blockInput = PromptEnvelopeSchema.parse(JSON.parse(block.text)).input;
  assert.equal(blockInput['kind'], 'block');
  assert.equal(z.object({ remedy: z.string() }).parse(blockInput['blocker']).remedy, 'Restore the dependency.');
});

test('answer continuation carries the accepted answer and only pending criteria', () => {
  const rendered = renderPrompt('answer_continuation', {
    taskId: 'task-1', attemptId: 'attempt-1', requestId: 'request-1',
    acceptedAnswer: { kind: 'text', text: 'Use the bounded fixture.' },
    scopeRevision: 1, completedWork: ['Initial analysis retained.'],
    pendingCriteria: [criteria[1]!],
  });
  const envelope = PromptEnvelopeSchema.parse(JSON.parse(rendered.text));

  assert.deepEqual(envelope.input['acceptedAnswer'], { kind: 'text', text: 'Use the bounded fixture.' });
  assert.deepEqual(envelope.input['pendingCriteria'], [criteria[1]]);
});

test('sanitized premature-done result uses a distinct incomplete-fix template', () => {
  const verifier = renderPrompt('verifier_handoff', {
    task: { ...task, title: 'Verify', description: 'Run native checks.' },
    repository: { id: 'repo-1', projectId: 'project-1', canonicalIdentity: 'repo:fixture', revision: 1 },
    verification: { repositoryId: 'repo-1', repositoryRevision: 1, sourceBranch: 'work/fixture',
      sourceCommit: 'a'.repeat(40), requestedValidation: 'Run the fixture checks.',
      contextDigest: `sha256:${'b'.repeat(64)}` },
  });
  const incomplete = renderPrompt('fix_incomplete', {
    attemptId: 'attempt-1', acceptance: { id: 'acceptance-1', taskId: 'task-1', resultId: 'result-1',
      actorId: 'user-1', decision: 'incomplete', missingCriteria: ['criterion-2'],
      note: 'Premature completion was reported.', createdAt: new Date(0).toISOString() },
    pendingCriteria: [criteria[1]!], referenceIds: [],
  });

  assert.equal(verifier.templateId, 'verifier_handoff');
  assert.equal(incomplete.templateId, 'fix_incomplete');
  assert.deepEqual(PromptEnvelopeSchema.parse(JSON.parse(incomplete.text)).input['acceptance'], {
    actorId: 'user-1', createdAt: new Date(0).toISOString(), decision: 'incomplete', id: 'acceptance-1',
    missingCriteria: ['criterion-2'], note: 'Premature completion was reported.', resultId: 'result-1', taskId: 'task-1',
  });
  assert.notEqual(verifier.digest, incomplete.digest);
});
