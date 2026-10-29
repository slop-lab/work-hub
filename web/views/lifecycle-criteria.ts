import { commandId } from "../api.ts";
import { badge, el, findFormValue, label, submitButton } from "../dom.ts";
import type { TaskLifecycle } from "../lifecycle-api.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function lifecycleCriteria(ctx: UiContext, task: HubTask, lifecycle: TaskLifecycle): HTMLElement {
	const current = lifecycle.criteria.filter((criterion) => criterion.supersededByCriterionId === undefined);
	return el(
		"div",
		{ class: "lifecycle-grid" },
		criteriaHistory(lifecycle),
		amendmentForm(ctx, task, current),
		acceptanceForm(ctx, task, lifecycle),
	);
}

function criteriaHistory(lifecycle: TaskLifecycle): HTMLElement {
	const coverage = lifecycle.projection.criterionCoverage;
	return el(
		"section",
		{ class: "lifecycle-pane", "aria-label": "Criteria history" },
		el("div", { class: "section-heading" }, el("h3", {}, "Criteria"), badge(`${coverage.satisfied}/${coverage.required}`, coverage.satisfied === coverage.required ? "success" : "warning")),
		el("p", { class: "muted" }, `${coverage.satisfied} of ${coverage.required} required criteria satisfied`),
		lifecycle.criteria.length === 0
			? el("p", { class: "muted" }, "No explicit criteria have been added.")
			: el("div", { class: "lifecycle-rows" }, ...lifecycle.criteria.map((criterion) => el(
				"article",
				{ class: "lifecycle-row" },
				el("div", { class: "cluster" }, badge(criterion.key), badge(criterion.requirement, criterion.requirement === "required" ? "warning" : "neutral"), badge(`${criterion.verification} verification`, criterion.verification === "required" ? "info" : "neutral"), criterion.supersededByCriterionId === undefined ? null : badge("superseded")),
				el("p", { class: "lifecycle-criterion-copy" }, criterion.description),
				el("span", { class: "mono" }, criterion.id),
			))),
		lifecycle.amendments.length === 0 ? null : el("details", {}, el("summary", {}, `${lifecycle.amendments.length} scope amendment${lifecycle.amendments.length === 1 ? "" : "s"}`), el("div", { class: "lifecycle-rows" }, ...lifecycle.amendments.map((amendment) => el("article", { class: "lifecycle-row" }, el("strong", {}, `Revision ${amendment.revision}`), el("p", {}, amendment.summary), el("span", { class: "mono" }, amendment.id))))),
	);
}

function amendmentForm(ctx: UiContext, task: HubTask, criteria: TaskLifecycle["criteria"]): HTMLElement {
	const summary = el("input", { class: "input", name: "summary", required: true });
	const key = el("input", { class: "input", name: "key", required: true, pattern: "[A-Za-z0-9._-]+" });
	const description = el("textarea", { class: "textarea", name: "description", rows: "3", required: true });
	const requirement = select("requirement", [["required", "Required"], ["optional", "Optional"]]);
	const verification = select("verification", [["required", "Required"], ["optional", "Optional"]]);
	const supersedes = select("supersedes", [["", "Does not supersede a criterion"], ...criteria.map((criterion) => [criterion.id, `${criterion.key}: ${criterion.description}`] as const)]);
	const form = el("form", { class: "lifecycle-form", "data-form-key": `lifecycle-amend:${task.id}` }, label("Amendment summary", summary), label("Criterion key", key), label("Criterion description", description), el("div", { class: "lifecycle-form__pair" }, label("Requirement", requirement), label("Verification", verification)), label("Supersede criterion", supersedes), submitButton("Add criteria amendment", "secondary"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const superseded = findFormValue(form, "supersedes");
		void ctx.command({ commandId: commandId(), type: "task.amend", target: { kind: "task", id: task.id }, expected: { task: task.revision }, payload: {
			summary: findFormValue(form, "summary"),
			criteria: [{ key: findFormValue(form, "key"), description: findFormValue(form, "description"), requirement: requirement.value, verification: verification.value }],
			supersedesCriterionIds: superseded.length === 0 ? [] : [superseded],
		} }, "Task criteria amended.");
	});
	return el("details", { class: "lifecycle-pane lifecycle-disclosure" }, el("summary", {}, "Amend criteria"), form);
}

function acceptanceForm(ctx: UiContext, task: HubTask, lifecycle: TaskLifecycle): HTMLElement {
	const currentResult = task.status === "backlog" || task.status === "canceled"
		? undefined
		: lifecycle.acceptance?.decision === "accepted"
			? ctx.state.results.find((result) => result.id === lifecycle.acceptance?.resultId)
			: ctx.state.results.find((result) => result.taskId === task.id && result.attemptId === task.primaryAttemptId);
	const currentAttempt = ctx.state.attempts.find((attempt) => attempt.id === task.primaryAttemptId);
	const decision = select("decision", [["accepted", "Accept current final result"], ["incomplete", "Mark incomplete"], ["rejected", "Reject result"]]);
	const activeDecision = select("activeExecutionDecision", [["", "Choose stop or continue"], ["request_stop", "Request stop"], ["allow_to_continue", "Allow work to continue"]]);
	const accepted = decision.options.item(0);
	if (accepted !== null && lifecycle.projection.criterionCoverage.missing.length > 0) {
		accepted.disabled = true;
		decision.value = "incomplete";
	}
	const note = el("textarea", { class: "textarea", name: "note", rows: "3" });
	const submit = submitButton("Record acceptance decision", "primary");
	submit.disabled = currentResult?.kind !== "final" || lifecycle.acceptance?.decision === "accepted";
	const form = el(
		"form",
		{ class: "lifecycle-pane lifecycle-form", "data-form-key": `lifecycle-accept:${task.id}` },
		el("h3", {}, "Current result decision"),
		currentResult === undefined ? el("p", { class: "muted" }, "No result is available for the current attempt.") : el(
			"div",
			{ class: "lifecycle-current-result" },
			el("div", { class: "cluster" }, badge(currentResult.kind, currentResult.kind === "final" ? "success" : "warning"), badge(`${currentResult.criterionEvidence.length} criterion evidence`)),
			el("strong", {}, currentResult.summary),
			currentResult.evidence.length === 0 ? el("p", { class: "muted" }, "No supporting evidence recorded.") : el("ul", { class: "plain-list" }, ...currentResult.evidence.map((item) => el("li", {}, item.detail))),
		),
		lifecycle.projection.criterionCoverage.missing.length === 0 ? el("p", { class: "muted" }, "No required criteria are missing from the current result.") : el("div", { class: "boundary-note" }, el("strong", {}, "Computed result gaps"), el("ul", { class: "plain-list" }, ...lifecycle.projection.criterionCoverage.missing.map((id) => el("li", {}, lifecycle.criteria.find((criterion) => criterion.id === id)?.key ?? id)))),
		label("Acceptance decision", decision),
		currentAttempt?.unresolved === true ? label("Active execution decision", activeDecision) : null,
		label("Decision note", note),
		submit,
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (currentResult?.kind !== "final") return;
		const selected = decision.value;
		const activeExecutionDecision = selected === "accepted" && currentAttempt?.unresolved === true
			? executionDecision(activeDecision.value) : undefined;
		if (selected === "accepted" && currentAttempt?.unresolved === true && activeExecutionDecision === undefined) {
			ctx.notice("Choose whether active work should stop or continue before accepting the result.", "error");
			return;
		}
		const missingCriteria = selected === "accepted" ? [] : lifecycle.projection.criterionCoverage.missing;
		void ctx.command({ commandId: commandId(), type: "task.acceptResult", target: { kind: "task", id: task.id }, expected: { task: task.revision }, payload: { resultId: currentResult.id, decision: selected, missingCriteria, note: findFormValue(form, "note") || undefined, ...(activeExecutionDecision === undefined ? {} : { activeExecutionDecision }) } }, selected === "accepted" ? "Current final result accepted." : "Result decision recorded with current gaps.");
	});
	return form;
}

function executionDecision(value: string): "request_stop" | "allow_to_continue" | undefined {
	if (value === "request_stop" || value === "allow_to_continue") return value;
	return undefined;
}

function select(name: string, options: readonly (readonly [string, string])[]): HTMLSelectElement {
	return el("select", { class: "select", name }, ...options.map(([value, text]) => el("option", { value }, text)));
}
