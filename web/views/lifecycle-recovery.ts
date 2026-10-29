import { commandId } from "../api.ts";
import { badge, el, findFormValue, label, submitButton } from "../dom.ts";
import type { LifecycleAttempt, TaskLifecycle } from "../lifecycle-api.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function lifecycleRecovery(ctx: UiContext, task: HubTask, lifecycle: TaskLifecycle, focusedAttemptId?: string): HTMLElement {
	const attempts = lifecycle.attempts.filter((attempt) => focusedAttemptId === undefined || attempt.id === focusedAttemptId);
	return el(
		"section",
		{ class: "lifecycle-pane", "aria-label": "Attempt recovery" },
		el("div", { class: "section-heading" }, el("h3", {}, "Attempt recovery"), badge(String(attempts.length), attempts.some((item) => item.interruption !== undefined) ? "warning" : "neutral")),
		attempts.length === 0 ? el("p", { class: "muted" }, "No execution attempt is linked to this task yet.") : el("div", { class: "lifecycle-rows" }, ...attempts.map((attempt) => recoveryRow(ctx, task, attempt))),
	);
}

function recoveryRow(ctx: UiContext, task: HubTask, lifecycleAttempt: LifecycleAttempt): HTMLElement {
	const attempt = ctx.state.attempts.find((item) => item.id === lifecycleAttempt.id);
	return el(
		"article",
		{ class: "lifecycle-row" },
		el("div", { class: "cluster" }, badge(attempt?.phase ?? "retained"), badge(lifecycleAttempt.interruption === undefined ? "not interrupted" : readable(lifecycleAttempt.interruption), lifecycleAttempt.interruption === undefined ? "neutral" : "warning"), badge(readable(lifecycleAttempt.recovery), lifecycleAttempt.recovery === "none" ? "neutral" : "info")),
		el("span", { class: "mono" }, lifecycleAttempt.id),
		el("p", { class: "muted" }, `Retry ${lifecycleAttempt.retry.ordinal} of ${lifecycleAttempt.retry.limit}`),
		lifecycleAttempt.retry.reason === undefined ? null : el("p", {}, lifecycleAttempt.retry.reason),
		lifecycleAttempt.interruption === undefined ? reconcileForm(ctx, task, lifecycleAttempt.id) : recoveryForm(ctx, task, lifecycleAttempt),
	);
}

function reconcileForm(ctx: UiContext, task: HubTask, attemptId: string): HTMLElement {
	const interruption = select("interruption", [["paused", "Paused"], ["awaiting_input", "Awaiting input"], ["provider_stop", "Provider stop"], ["operator_stop", "Operator stop"], ["retryable_failure", "Retryable failure"], ["crash", "Crash"], ["unknown", "Unknown or disconnected"]]);
	const recovery = select("recovery", [["observe", "Continue observation"], ["reconcile", "Reconcile provider state"]]);
	const note = el("textarea", { class: "textarea", name: "note", rows: "2", required: true });
	const form = el("form", { class: "lifecycle-inline-form", "data-form-key": `lifecycle-reconcile:${task.id}:${attemptId}` }, label("Interruption kind", interruption), label("Observation action", recovery), label("Reconciliation note", note), submitButton("Record interruption", "secondary"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void ctx.command({ commandId: commandId(), type: "attempt.reconcile", target: { kind: "attempt", id: attemptId }, payload: { interruption: interruption.value, recovery: recovery.value, note: findFormValue(form, "note") } }, "Attempt interruption recorded for deliberate recovery.");
	});
	return el("details", { class: "lifecycle-disclosure" }, el("summary", {}, "Record interruption details"), form);
}

function recoveryForm(ctx: UiContext, task: HubTask, attempt: LifecycleAttempt): HTMLElement {
	const retryExhausted = attempt.retry.ordinal > 0 && attempt.retry.ordinal >= attempt.retry.limit;
	const action = select("action", [["resume", "Resume same work"], ...(retryExhausted ? [] : [["retry", "Bounded retry"]] as const), ["escalated", "Escalate without retry"]]);
	const reason = el("textarea", { class: "textarea", name: "reason", rows: "2", required: true });
	const limit = el("input", { class: "input", name: "retryLimit", type: "number", min: "0", max: "20", value: String(Math.max(attempt.retry.limit, 1)), required: true });
	limit.readOnly = attempt.retry.ordinal > 0;
	const limitHelp = attempt.retry.ordinal > 0
		? "The retry budget is retained from the first retry."
		: "The service rejects retries beyond this retained budget.";
	const exhausted = retryExhausted
		? el("p", { class: "limitation" }, `Retry budget exhausted at ${attempt.retry.ordinal} of ${attempt.retry.limit}. Resume or escalate instead.`)
		: null;
	const form = el(
		"form",
		{ class: "lifecycle-inline-form", "data-form-key": `lifecycle-recovery:${task.id}:${attempt.id}` },
		label("Recovery action", action),
		label("Recovery reason", reason),
		label("Retry limit", limit, limitHelp),
		exhausted,
		submitButton("Controlled recovery", "secondary"),
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void ctx.command({ commandId: commandId(), type: "attempt.controlledResume", target: { kind: "attempt", id: attempt.id }, payload: { recovery: action.value, reason: findFormValue(form, "reason"), retryLimit: Number(findFormValue(form, "retryLimit")) } }, "Controlled recovery started with retained attempt linkage.");
	});
	return el("details", { class: "lifecycle-disclosure", open: true }, el("summary", {}, "Controlled recovery options"), form);
}

function select(name: string, options: readonly (readonly [string, string])[]): HTMLSelectElement {
	return el("select", { class: "select", name }, ...options.map(([value, text]) => el("option", { value }, text)));
}

function readable(value: string): string {
	return value.replaceAll("_", " ");
}
