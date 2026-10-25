import { z } from 'zod';
import { NativeRefSchema, SerializedOperationReceiptSchema, TimestampSchema } from './common.ts';
import { ResourceIdentitySchema } from './execution.ts';
import { RuntimeTargetSchema } from './runtime.ts';

export const DetachAttachmentInputSchema = z.strictObject({ attachmentRef: NativeRefSchema, expectedIdentity: ResourceIdentitySchema });
export const RequestControlInputSchema = z.strictObject({ target: RuntimeTargetSchema,
  requestedActions: z.array(z.enum(['start_attempt', 'send_instruction', 'deliver_response', 'request_stop', 'interactive_input'])),
});
export const ReadOutputInputSchema = z.strictObject({ target: RuntimeTargetSchema, after: z.string().optional(), limit: z.number().int().positive() });
export const SubscribeInputSchema = z.strictObject({ target: RuntimeTargetSchema, after: z.string().optional() });
export const RuntimeReadinessSchema = z.strictObject({ ready: z.boolean(), unmetRequirements: z.array(z.string()) });
export const OperationLookupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('found'), receipt: SerializedOperationReceiptSchema }),
  z.strictObject({ kind: z.literal('not_found'), absence: z.enum(['proven_not_executed', 'not_authoritative']) }),
  z.strictObject({ kind: z.literal('unsupported'), reason: z.string() }),
]);
export function observationSchema<T extends z.ZodType>(value: T) {
  return z.strictObject({ value, sourceInstallationId: z.string().min(1), observedAt: TimestampSchema,
    sourceCursor: z.string().optional(), assurance: z.enum(['authoritative', 'reported', 'partial']), limitations: z.array(z.string()) });
}
