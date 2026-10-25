import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { invalid } from '../domain/errors.ts';
import { parseJson } from '../persistence/codec.ts';
import { singleAttemptPolicy } from '../domain/delegation-policy.ts';

type ContextSelection = { readonly workspaceId: string; readonly taskId: string; readonly selectedReferenceIds: readonly string[]; readonly selectedResponseIds: readonly string[] };
type ContextItem = { readonly sourceId: string; readonly sourceRevision?: number; readonly includedText?: string; readonly omissionReason?: string };
export function assembleContext(database: DatabaseSync, selection: ContextSelection): readonly ContextItem[] {
  const task = z.object({ projectId: z.string(), revision: z.number(), title: z.string(), description: z.string(), expectedOutcome: z.string().nullable() }).parse(database.prepare('SELECT project_id AS projectId,revision,title,description,expected_outcome AS expectedOutcome FROM tasks WHERE workspace_id=? AND id=?').get(selection.workspaceId, selection.taskId));
  const items: ContextItem[] = [{ sourceId: selection.taskId, sourceRevision: task.revision, includedText: [task.title, task.description, task.expectedOutcome ?? ''].filter(Boolean).join('\n\n') }];
  items.push({ sourceId: `input-policy:${singleAttemptPolicy.id}`, sourceRevision: Number(singleAttemptPolicy.version), includedText: JSON.stringify({ id: singleAttemptPolicy.id, version: singleAttemptPolicy.version }) });
  for (const id of selection.selectedReferenceIds) {
    const raw = database.prepare('SELECT kind,title,retained_text AS text,locator_json AS locator,availability FROM references_store WHERE workspace_id=? AND id=? AND task_id=?').get(selection.workspaceId, id, selection.taskId);
    if (!raw) throw invalid('selected_reference_unavailable', 'A selected reference is not available in this task.');
    const reference = z.object({ kind: z.string(), title: z.string(), text: z.string().nullable(), locator: z.string().nullable(), availability: z.string() }).parse(raw);
    if (reference.kind === 'text' && reference.text !== null) items.push({ sourceId: id, sourceRevision: 1, includedText: `${reference.title}\n${reference.text}` });
    else if (reference.kind === 'link' && reference.locator) items.push({ sourceId: id, sourceRevision: 1, includedText: `${reference.title}\n${z.object({ url: z.string() }).parse(parseJson(reference.locator)).url}`, omissionReason: 'remote_content_not_fetched' });
    else items.push({ sourceId: id, omissionReason: 'reference_content_unavailable' });
  }
  for (const id of selection.selectedResponseIds) {
    const raw = database.prepare(`SELECT q.prompt,r.request_revision AS revision,r.answer_json AS answer FROM responses r JOIN requests q ON q.id=r.request_id WHERE r.workspace_id=? AND r.id=? AND q.project_id=? AND (q.task_id IS NULL OR q.task_id=?) AND q.status='answered'`).get(selection.workspaceId, id, task.projectId, selection.taskId);
    if (!raw) throw invalid('selected_response_unavailable', 'A selected answer is not valid context for this task.');
    const response = z.object({ prompt: z.string(), revision: z.number(), answer: z.string() }).parse(raw);
    items.push({ sourceId: id, sourceRevision: response.revision, includedText: `${response.prompt}\n${response.answer}` });
  }
  const bytes = items.reduce((total, item) => total + Buffer.byteLength(item.includedText ?? ''), 0);
  if (bytes > 131072) throw invalid('context_selection_too_large', 'Selected context exceeds 128 KiB. Choose fewer references or a shorter task brief. Nothing was truncated.');
  return items;
}
