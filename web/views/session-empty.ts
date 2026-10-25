import { commandId, loadTasks } from "../api.ts";
import type { HubTask } from "../state-schema.ts";
import { el, findFormValue, label, submitButton } from "../dom.ts";
import type { UiContext } from "../ui-context.ts";

export function emptySession(ctx: UiContext): HTMLElement {
	const task = el("select", { class: "select", name: "task" });
	let availableTasks: readonly HubTask[] = [];
	const profile = el("select", { class: "select", name: "profile" });
	for (const item of ctx.state.profiles.filter((candidate) => candidate.enabled)) profile.append(el("option", { value: item.id }, item.label));
	const nativeSession = el("input", { class: "input", name: "nativeSession", required: true, placeholder: "Native session ID" });
	const control = el("select", { class: "select", name: "controlMode" }, el("option", { value: "observe" }, "Observe only"), el("option", { value: "control" }, "Request control"));
	const form = el(
		"form",
		{ class: "detail-section stack" },
		el("h2", {}, "Attach existing agent session"),
		el("p", {}, "Attachment sends no greeting, task prompt, or resume command. Observe-only is the safe default."),
		label("Task context", task),
		label("Runtime profile", profile),
		label("Native session ID", nativeSession),
		label("Requested access", control),
		submitButton("Attach without starting work"),
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const taskId = findFormValue(form, "task");
		const profileId = findFormValue(form, "profile");
		const selectedTask = availableTasks.find((item) => item.id === taskId);
		const selectedProfile = ctx.state.profiles.find((item) => item.id === profileId);
		if (selectedTask === undefined || selectedProfile === undefined) return;
		void ctx.command(
			{
				commandId: commandId(),
				type: "session.attach",
				target: { kind: "task", id: taskId },
				expected: { task: selectedTask.revision, profile: selectedProfile.revision },
				payload: { profileId, controlMode: findFormValue(form, "controlMode"), nativeSession: { installationId: selectedProfile.runtimeInstallationId, providerScope: "workspace", kind: "agent-session", id: findFormValue(form, "nativeSession") }, environment: { mode: "none" } },
			},
			"Native session attached without submitting work.",
		);
	});
	void loadTasks({ limit: 50 }).then((page) => {
		availableTasks = page.items;
		task.replaceChildren(...page.items.map((item) => el("option", { value: item.id }, item.title)));
	}).catch((error: unknown) => ctx.notice(error instanceof Error ? error.message : "Task context could not be loaded.", "error"));
	return el(
		"div",
		{ class: "page" },
		el("header", { class: "page-heading" }, el("div", {}, el("p", { class: "kicker" }, "Session workspace"), el("h1", {}, "No session selected"), el("p", { class: "lead" }, "Delegate a task, or attach an existing native session without starting new work."))),
		el("div", { class: "settings-grid" }, el("div", { class: "empty-state empty-state--large" }, el("h2", {}, "Start from the task"), el("p", {}, "The normal path previews profile, environment, and effects before delegation."), el("a", { class: "button button--primary", href: "#/backlog" }, "Open backlog")), form),
	);
}
