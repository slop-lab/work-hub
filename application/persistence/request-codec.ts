import { z } from 'zod';
import type { RequestView } from '../domain/model.ts';
import { parseJson } from './codec.ts';

const rowSchema = z.object({
  id: z.string(), workspace_id: z.string(), project_id: z.string(), task_id: z.string().nullable(), session_id: z.string().nullable(), attempt_id: z.string().nullable(), binding_generation: z.number().nullable(), revision: z.number(), kind: z.enum(['question', 'approval']), author_id: z.string(), recipient_json: z.string(), prompt: z.string(), reason: z.string().nullable(), answer_schema_json: z.string(), blocking: z.enum(['none', 'before_delegate', 'runtime_action']), validity_json: z.string(), status: z.enum(['open', 'answered', 'withdrawn', 'expired', 'superseded']), response_route: z.enum(['none', 'native', 'bridge']), expires_at: z.string().nullable(), created_at: z.string(), updated_at: z.string(),
});
const objectSchema = z.record(z.string(), z.unknown());
export type NewRequest = {
  readonly workspaceId: string; readonly authorId: string; readonly projectId: string;
  readonly taskId?: string; readonly sessionId?: string; readonly attemptId?: string;
  readonly bindingGeneration?: number; readonly kind: 'question' | 'approval';
  readonly recipient: object; readonly prompt: string; readonly reason?: string;
  readonly referenceIds: readonly string[]; readonly answerSchema: object;
  readonly blocking: 'none' | 'before_delegate' | 'runtime_action'; readonly validity: object;
  readonly actionDescription?: object; readonly supersedesRequestId?: string;
  readonly responseRoute: 'none' | 'native' | 'bridge';
};
export function toRequest(raw: unknown): RequestView {
  const row = rowSchema.parse(raw);
  return {
    id: row.id, workspaceId: row.workspace_id, projectId: row.project_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    ...(row.binding_generation === null ? {} : { bindingGeneration: row.binding_generation }),
    revision: row.revision, kind: row.kind, authorId: row.author_id,
    recipient: objectSchema.parse(parseJson(row.recipient_json)), prompt: row.prompt,
    ...(row.reason === null ? {} : { reason: row.reason }),
    answerSchema: objectSchema.parse(parseJson(row.answer_schema_json)), blocking: row.blocking,
    validity: objectSchema.parse(parseJson(row.validity_json)), status: row.status, responseRoute: row.response_route,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
