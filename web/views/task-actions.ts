import { commandId } from "../api.ts";
import { button, el, findFormValue, label } from "../dom.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function taskActions(ctx: UiContext, task: HubTask): HTMLElement {
	const note = el("textarea", { class: "textarea", name: "completionNote", rows: "3", placeholder: "Record the human decision" });
  const hasActiveWork = ctx.state.attempts.some((attempt) => attempt.id === task.primaryAttemptId && attempt.phase !== 'finished');
  const execution = el("select", { class: "select", name: "activeExecutionDecision", required: hasActiveWork }, el('option', { value: '' }, 'Choose execution consequence'), el("option", { value: "allow_to_continue" }, "Allow active execution to continue"), el("option", { value: "request_stop" }, "Request stop separately"));
  const executionField = label('If execution is active', execution);
  executionField.hidden = !hasActiveWork;
  const form = el("form", { class: "detail-section detail-section--caution stack" }, el("h2", {}, "Business decision"), el("p", {}, "Task status, runtime stop, session closure, and environment lifecycle are separate actions."), label("Completion note", note), executionField);
	const actions = el("div", { class: "cluster" });
	if (task.status === "done" || task.status === "canceled") {
		actions.append(button("Reopen to backlog", "secondary", () => void setStatus(ctx, task, form, "backlog")));
	} else {
		actions.append(button("Complete task", "primary", () => void setStatus(ctx, task, form, "done")), button("Cancel task", "danger", () => void setStatus(ctx, task, form, "canceled")));
	}
	actions.append(button("Archive task", "quiet", () => void ctx.command({ commandId: commandId(), type: "task.archive", target: { kind: "task", id: task.id }, expected: { task: task.revision }, payload: { reason: findFormValue(form, "completionNote") || undefined } }, "Task archived. History remains available.")));
	form.append(actions);
	return form;
}

async function setStatus(ctx: UiContext, task: HubTask, form: HTMLFormElement, status: HubTask["status"]): Promise<boolean> {
	const completionNote = findFormValue(form, "completionNote");
  const hasActiveWork = ctx.state.attempts.some((attempt) => attempt.id === task.primaryAttemptId && attempt.phase !== 'finished');
  const decision = findFormValue(form, 'activeExecutionDecision');
  if (hasActiveWork && decision !== 'request_stop' && decision !== 'allow_to_continue') { ctx.notice('Choose what should happen to active execution before changing task state.', 'error'); return false; }
  return ctx.command({ commandId: commandId(), type: "task.setStatus", target: { kind: "task", id: task.id }, expected: { task: task.revision }, payload: { status, completionNote: completionNote || undefined, ...(hasActiveWork ? { activeExecutionDecision: decision } : {}) } }, status === "done" ? "Task completed. Runtime and environment state are unchanged." : status === "canceled" ? "Task canceled. Runtime effects remain separately tracked." : "Task reopened without starting work.");
}
