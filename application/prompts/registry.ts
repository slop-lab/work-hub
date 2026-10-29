import { z } from 'zod';
import { canonicalJson, digest } from '../persistence/codec.ts';
import type { PromptPresentationOverride, PromptTemplateInputMap, RenderedPrompt, TemplateId } from './types.ts';

export const promptRegistry = {
  task_brief: { version: 1 },
  status_result: { version: 1 },
  question_block: { version: 1 },
  answer_continuation: { version: 1 },
  verifier_handoff: { version: 1 },
  fix_incomplete: { version: 1 },
} as const satisfies Record<TemplateId, { readonly version: 1 }>;

export const promptOutput = {
  channels: ['checkpoint', 'final', 'criteria', 'block'],
  lifecycleSignals: 'structured_only',
} as const;

export const promptAuthority = {
  taskCompletion: 'human_only',
  proseLifecycleAuthority: false,
} as const;

export const PromptEnvelopeSchema = z.strictObject({
  contract: z.literal('workhub.prompt.v1'),
  template: z.strictObject({
    id: z.enum(['task_brief', 'status_result', 'question_block', 'answer_continuation', 'verifier_handoff', 'fix_incomplete']),
    version: z.literal(1),
  }),
  input: z.record(z.string(), z.unknown()),
  output: z.strictObject({
    channels: z.tuple([z.literal('checkpoint'), z.literal('final'), z.literal('criteria'), z.literal('block')]),
    lifecycleSignals: z.literal('structured_only'),
  }),
  authority: z.strictObject({
    taskCompletion: z.literal('human_only'),
    proseLifecycleAuthority: z.literal(false),
  }),
  presentation: z.strictObject({ header: z.string().max(2000).optional(),
    footer: z.string().max(2000).optional() }).optional(),
});

const presentationSchema = PromptEnvelopeSchema.shape.presentation.unwrap();

export function renderPrompt<T extends TemplateId>(
  templateId: T,
  input: PromptTemplateInputMap[T],
  presentation?: PromptPresentationOverride,
): RenderedPrompt<T> {
  const version = promptRegistry[templateId].version;
  const envelope = {
    contract: 'workhub.prompt.v1',
    template: { id: templateId, version },
    input,
    output: promptOutput,
    authority: promptAuthority,
    ...(presentation === undefined ? {} : { presentation: presentationSchema.parse(presentation) }),
  } as const;
  const text = canonicalJson(envelope);
  return {
    templateId,
    version,
    text,
    digest: digest(text),
    inputDigest: digest(input),
    output: promptOutput,
  };
}
