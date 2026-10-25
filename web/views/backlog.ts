import { commandId } from "../api.ts";
import { badge, button, el, findFormValue, formatTime, label, submitButton } from "../dom.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";
import { taskDetailView } from "./task-detail.ts";

export function backlogView(ctx: UiContext, taskId?: string): HTMLElement {
	if (taskId !== undefined) {
		const task = ctx.state.tasks.find((item) => item.id === taskId);
		if (task !== undefined) return taskDetailView(ctx, task);
	}
	const search = el("input", {
		class: "input input--search",
		type: "search",
		placeholder: "Title, description, outcome",
		"aria-label": "Search tasks",
	});
	const status = el("select", { class: "select", "aria-label": "Filter by status" }, el("option", { value: "all" }, "All states"), el("option", { value: "backlog" }, "Backlog"), el("option", { value: "active" }, "Active"), el("option", { value: "review" }, "Review"), el("option", { value: "done" }, "Done"));
	const project = filterSelect("Filter by project", "All projects", ctx.state.projects.map((item) => [item.id, item.name]));
	const owner = filterSelect("Filter by owner", "All owners", ctx.state.users.map((item) => [item.id, item.displayName]));
	const priority = filterSelect("Filter by priority", "All priorities", [["urgent", "Urgent"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]]);
	const list = el("div", { class: "task-list" });
	const render = (): void => {
		const query = search.value.trim().toLocaleLowerCase();
		const selectedStatus = status.value;
		const tasks = ctx.state.tasks.filter((task) => task.archivedAt === undefined && (selectedStatus === "all" || task.status === selectedStatus) && (project.value === "all" || task.projectId === project.value) && (owner.value === "all" || task.ownerId === owner.value) && (priority.value === "all" || task.priority === priority.value) && `${task.title} ${task.description} ${task.expectedOutcome ?? ""}`.toLocaleLowerCase().includes(query));
		list.replaceChildren(...tasks.map((task) => taskRow(ctx, task)));
		if (tasks.length === 0) list.append(el("div", { class: "empty-state" }, el("h2", {}, "No matching work"), el("p", {}, "Adjust the search or capture a new task.")));
	};
	search.addEventListener("input", render);
	status.addEventListener("change", render);
	project.addEventListener("change", render);
	owner.addEventListener("change", render);
	priority.addEventListener("change", render);
	render();
	return el(
		"div",
		{ class: "page" },
		el("header", { class: "page-heading" }, el("div", {}, el("p", { class: "kicker" }, "Project backlog"), el("h1", {}, "Work stays understandable"), el("p", { class: "lead" }, "Capture a title first. Add execution only when the work is ready."))),
		captureForm(ctx),
		el("div", { class: "filter-bar" }, search, project, status, owner, priority),
		list,
	);
}

function captureForm(ctx: UiContext): HTMLElement {
	const input = el("input", {
		class: "input input--title",
		name: "title",
		required: true,
		maxlength: "240",
		placeholder: "What needs to change?",
		"aria-label": "New task title",
	});
	const project = el("select", { class: "select", name: "projectId" });
	for (const item of ctx.state.projects) project.append(el("option", { value: item.id }, item.name));
	const form = el("form", { class: "capture-form" }, label("Task project", project), label("New task", input), submitButton("Add task"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const title = findFormValue(form, "title");
		if (title.length === 0) return;
		const submit = form.querySelector<HTMLButtonElement>("button");
		if (submit !== null) submit.disabled = true;
		void ctx
			.command(
				{
					commandId: commandId(),
					type: "task.create",
					payload: {
						projectId: findFormValue(form, "projectId"),
						title,
					},
				},
				"Task captured.",
			)
			.then((saved) => {
				if (saved) input.value = "";
			})
			.finally(() => {
				if (submit !== null) submit.disabled = false;
			});
	});
	return form;
}

function filterSelect(labelText: string, allText: string, options: readonly (readonly [string, string])[]): HTMLSelectElement {
	const select = el("select", { class: "select", "aria-label": labelText }, el("option", { value: "all" }, allText));
	for (const [value, text] of options) select.append(el("option", { value }, text));
	return select;
}

function taskRow(ctx: UiContext, task: HubTask): HTMLElement {
	const owner = ctx.state.users.find((user) => user.id === task.ownerId)?.displayName ?? "Unassigned";
	return el(
		"article",
		{ class: "task-row" },
		el("div", { class: "task-row__state" }, badge(task.status, statusTone(task.status)), badge(task.priority, task.priority === "urgent" || task.priority === "high" ? "warning" : "neutral")),
		el("div", { class: "task-row__body" }, el("h2", {}, task.title), el("p", {}, task.description || "No description yet."), el("span", { class: "task-row__meta" }, `${owner} · Updated ${formatTime(task.updatedAt)}`)),
		button(`Open ${task.title}`, "quiet", () => ctx.navigate(`#/backlog/${task.id}`)),
	);
}

function statusTone(status: HubTask["status"]): string {
	if (status === "done") return "success";
	if (status === "review") return "warning";
	if (status === "active") return "info";
	if (status === "canceled") return "error";
	return "neutral";
}
