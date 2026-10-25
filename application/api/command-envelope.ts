import { z } from 'zod';

export const commandEnvelope = z.strictObject({
  commandId: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  target: z.strictObject({ kind: z.string(), id: z.string() }).optional(),
  expected: z.strictObject({ task: z.number().int(), profile: z.number().int(), request: z.number().int(), registration: z.number().int(), session: z.number().int(), bindingGeneration: z.number().int() }).partial().optional(),
  payload: z.record(z.string(), z.json()),
});
