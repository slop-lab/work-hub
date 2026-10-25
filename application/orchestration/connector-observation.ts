import { z, type ZodType } from 'zod';
import { TimestampSchema, type CallContext, type Observation } from '../contracts/index.ts';

export function validateConnectorObservation<T>(input: {
  readonly observation: Observation<T>; readonly context: CallContext; readonly schema: ZodType;
}): Observation<T> {
  z.strictObject({ value: input.schema, sourceInstallationId: z.literal(input.context.installationId),
    observedAt: TimestampSchema, sourceCursor: z.string().optional(),
    assurance: z.enum(['authoritative', 'reported', 'partial']), limitations: z.array(z.string()),
  }).parse(input.observation);
  return input.observation;
}
