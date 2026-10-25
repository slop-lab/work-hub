import { commandId } from "../api.ts";
import { delegationDialog } from "../dialogs.ts";
import { badge, button, el, findFormValue, formatTime, label, submitButton } from "../dom.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";
import { questionSection } from "./question-form.ts";
import { resultSection } from "./result-review.ts";
import { taskHistory } from "./task-history.ts";
import { taskActions } from "./task-actions.ts";
import { referenceSection } from "./task-references.ts";

export function taskDetailView(ctx: UiContext, task: HubTask): HTMLElement {
	const session = ctx.state.sessions.find((item) => item.taskId === task.id);
	const requests = ctx.state.requests.filter((item) => item.taskId === task.id);
	const results = ctx.state.results.filter((item) => item.taskId === task.id);
	const page = el(
		"div",
		{ class: "page task-detail" },
		el(
			"header",
			{ class: "task-hero" },
			el(
				"div",
				{},
				el("a", { class: "back-link", href: "#/backlog" }, "Back to backlog"),
				el("div", { class: "cluster" }, badge(task.status, task.status === "review" ? "warning" : "info"), badge(task.priority, "neutral")),
				el("h1", {}, task.title),
				el("p", { class: "lead" }, task.description || "Add the context another person or runtime will need."),
			),
			el(
				"div",
				{ class: "task-hero__actions" },
				button("Delegate", "primary", () => delegationDialog(ctx, task)),
				session === undefined
					? null
					: el(
							"a",
							{
								class: "button button--secondary",
								href: `#/session/${session.id}`,
							},
							"Session",
						),
			),
		),
		el(
			"div",
			{ class: "detail-layout" },
			el("div", { class: "stack stack--large" }, editSection(ctx, task), commentSection(ctx, task), referenceSection(ctx, task), questionSection(ctx, task), taskHistory(ctx, task), resultSection(ctx, task, results), taskActions(ctx, task)),
			el(
				"aside",
				{ class: "context-rail" },
				el(
					"section",
					{ class: "detail-section" },
					el("h2", {}, "Current state"),
					definitionList([
						["Project", ctx.state.projects.find((project) => project.id === task.projectId)?.name ?? task.projectId],
						["Owner", ctx.state.users.find((user) => user.id === task.ownerId)?.displayName ?? "Unassigned"],
						["Revision", String(task.revision)],
						["Updated", formatTime(task.updatedAt)],
					]),
				),
				el(
					"section",
					{ class: "detail-section" },
					el("h2", {}, "Questions"),
					requests.length === 0 ? el("p", { class: "muted" }, "No formal questions yet.") : el("ul", { class: "plain-list" }, ...requests.map((request) => el("li", {}, badge(request.status, request.status === "open" ? "warning" : "success"), el("span", {}, request.prompt)))),
				),
				session === undefined ? el("section", { class: "detail-section detail-section--caution" }, el("h2", {}, "No session"), el("p", {}, "This task is still fully usable. A session starts only after explicit delegation or attachment.")) : sessionSummary(ctx, session.id),
			),
		),
	);
	return page;
}

function editSection(ctx: UiContext, task: HubTask): HTMLElement {
	const title = el("input", {
		class: "input",
		name: "title",
		value: task.title,
		required: true,
	});
	const description = el("textarea", { class: "textarea", name: "description", rows: "5" }, task.description);
	const outcome = el("textarea", { class: "textarea", name: "expectedOutcome", rows: "3" }, task.expectedOutcome ?? "");
	const priority = el(
		"select",
		{ class: "select", name: "priority" },
		...["low", "medium", "high", "urgent"].map((value) => {
			const option = el("option", { value }, value);
			option.selected = task.priority === value;
			return option;
		}),
	);
	const owner = el("select", { class: "select", name: "ownerId" }, el("option", { value: "" }, "Unassigned"));
	for (const user of ctx.state.users.filter((item) => item.enabled !== false)) {
		const option = el("option", { value: user.id }, user.displayName);
		option.selected = task.ownerId === user.id;
		owner.append(option);
	}
	const form = el("form", { class: "detail-section form-grid" }, el("h2", {}, "Task brief"), label("Title", title), label("Description", description), label("Expected outcome", outcome), label("Priority", priority), label("Owner", owner), submitButton("Save task", "secondary"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void ctx.command(
			{
				commandId: commandId(),
				type: "task.update",
				target: { kind: "task", id: task.id },
				expected: { task: task.revision },
				payload: {
					title: findFormValue(form, "title"),
					description: findFormValue(form, "description"),
					expectedOutcome: findFormValue(form, "expectedOutcome"),
					priority: priorityValue(findFormValue(form, "priority")),
					ownerId: owner.value || null,
				},
			},
			"Task updated.",
		);
	});
	return form;
}

function commentSection(ctx: UiContext, task: HubTask): HTMLElement {
	const text = el("textarea", {
		class: "textarea",
		name: "comment",
		rows: "3",
		placeholder: "Add context or a progress note",
	});
	const form = el("form", { class: "detail-section" }, el("h2", {}, "Comment"), label("Comment text", text), submitButton("Add comment", "secondary"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = findFormValue(form, "comment");
		if (value.length === 0) return;
		void ctx
			.command(
				{
					commandId: commandId(),
					type: "task.comment",
					target: { kind: "task", id: task.id },
					expected: { task: task.revision },
					payload: { text: value, referenceIds: [] },
				},
				"Comment added.",
			)
			.then((saved) => {
				if (saved) text.value = "";
			});
	});
	return form;
}

function sessionSummary(ctx: UiContext, sessionId: string): HTMLElement {
	const session = ctx.state.sessions.find((item) => item.id === sessionId);
	if (session === undefined) return el("section");
	return el(
		"section",
		{ class: "detail-section" },
		el("h2", {}, "Session"),
		definitionList([
			["Runtime", session.runtimeLabel],
			["Control", session.controlMode],
			["Lifecycle", session.state],
			["Generation", String(session.bindingGeneration)],
		]),
		el("a", { class: "button button--secondary", href: `#/session/${session.id}` }, "Open session"),
	);
}

function definitionList(items: readonly (readonly [string, string])[]): HTMLElement {
	return el("dl", { class: "definition-list" }, ...items.flatMap(([term, value]) => [el("dt", {}, term), el("dd", {}, value)]));
}

function priorityValue(value: string): number {
	switch (value) {
		case "urgent":
			return 10;
		case "high":
			return 30;
		case "medium":
			return 50;
		case "low":
			return 80;
		default:
			return 50;
	}
}
