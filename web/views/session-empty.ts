import type { NativeRef } from "../../application/contracts/common.ts";
import { commandId, loadTasks } from "../api.ts";
import { el, findFormValue, label, submitButton } from "../dom.ts";
import { loadIntegrations } from "../integrations.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function emptySession(ctx: UiContext): HTMLElement {
	const task = el("select", { class: "select", name: "task" }, el("option", { value: "" }, "Choose a task"));
	let availableTasks: readonly HubTask[] = [];
	const profile = el("select", { class: "select", name: "profile" }, el("option", { value: "" }, "Choose a runtime profile"));
	for (const item of ctx.state.profiles.filter((candidate) => candidate.enabled && ctx.state.installations.some((installation) => installation.id === candidate.runtimeInstallationId && installation.available && installation.enabled))) profile.append(el("option", { value: item.id }, item.label));
	const nativeSession = el("input", { class: "input", name: "nativeSession", required: true, placeholder: "Native session ID" });
	const nativeField = label("Native session ID", nativeSession, "Simulator-only fallback. Live providers require a verified discovered reference.");
	const discoveredSession = el("select", { class: "select", name: "discoveredSession" }, el("option", { value: "" }, "Discover sessions after choosing a profile"));
	const externalField = label("Existing native session", discoveredSession, "Select the exact safe native reference returned for this runtime installation. Attachment sends no prompt.");
	let nativeReferences = new Map<string, NativeRef>();
	const control = el("select", { class: "select", name: "controlMode" }, el("option", { value: "observe" }, "Observe only"), el("option", { value: "control" }, "Request control"));
	const discoveryMessage = el("p", { class: "snapshot-meta", "aria-live": "polite" });
	const discoverSessions = async (): Promise<void> => {
		const selectedProfile = ctx.state.profiles.find((item) => item.id === profile.value);
		if (selectedProfile === undefined || selectedProfile.simulator) return;
		discoveredSession.disabled = true;
		discoveredSession.replaceChildren(el("option", { value: "" }, "Discovering native sessions…"));
		try {
			const inventory = await loadIntegrations();
			const connection = inventory.runtime.find((item) => item.installationId === selectedProfile.runtimeInstallationId);
			const sessions = connection?.status === "available" ? connection.value.sessions : [];
			nativeReferences = new Map(sessions.map((item) => [item.id, item.nativeSession]));
			discoveredSession.replaceChildren(el("option", { value: "" }, sessions.length === 0 ? "No verified native sessions" : "Choose a native session"), ...sessions.map((item) => el("option", { value: item.id }, item.label)));
			const restoredSession = discoveredSession.dataset["restoredValue"];
			if (restoredSession !== undefined && nativeReferences.has(restoredSession)) discoveredSession.value = restoredSession;
			delete discoveredSession.dataset["restoredValue"];
			discoveredSession.disabled = sessions.length === 0;
			discoveryMessage.textContent = sessions.length === 0 ? "No attachable sessions were reported for the selected installation." : "";
		} catch (error) {
			discoveredSession.replaceChildren(el("option", { value: "" }, "Session discovery unavailable"));
			discoveryMessage.textContent = error instanceof Error ? error.message : "Session discovery failed.";
		}
	};
	const syncReference = (): void => {
		const external = ctx.state.profiles.find((item) => item.id === profile.value)?.simulator === false;
		nativeSession.required = !external;
		nativeSession.disabled = external;
		nativeField.hidden = external;
		externalField.hidden = !external;
		discoveredSession.required = external;
		if (external) void discoverSessions();
	};
	profile.addEventListener("change", syncReference);
	syncReference();
	const form = el(
		"form",
		{ class: "detail-section stack" },
		el("h2", {}, "Attach existing agent session"),
		el("p", {}, "Attachment sends no greeting, task prompt, or resume command. Observe-only is the safe default."),
		label("Task context", task),
		label("Runtime profile", profile),
		nativeField,
		externalField,
		discoveryMessage,
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
		let reference: NativeRef = { installationId: selectedProfile.runtimeInstallationId, providerScope: "workspace", kind: "agent-session", id: findFormValue(form, "nativeSession") };
		if (!selectedProfile.simulator) {
			const selectedReference = nativeReferences.get(discoveredSession.value);
			if (selectedReference === undefined || selectedReference.installationId !== selectedProfile.runtimeInstallationId) {
				ctx.notice("Select a discovered native session for this runtime installation.", "error"); return;
			}
			reference = selectedReference;
		}
		void ctx.command(
			{
				commandId: commandId(),
				type: "session.attach",
				target: { kind: "task", id: taskId },
				expected: { task: selectedTask.revision, profile: selectedProfile.revision },
				payload: { profileId, controlMode: findFormValue(form, "controlMode"), nativeSession: reference, environment: { mode: "none" } },
			},
			"Native session attached without submitting work.",
		);
	});
	void loadTasks({ limit: 50 }).then((page) => {
		availableTasks = page.items;
		task.replaceChildren(el("option", { value: "" }, "Choose a task"), ...page.items.map((item) => el("option", { value: item.id }, item.title)));
		const restoredTask = task.dataset["restoredValue"];
		if (restoredTask !== undefined && page.items.some((item) => item.id === restoredTask)) task.value = restoredTask;
		delete task.dataset["restoredValue"];
	}).catch((error: unknown) => ctx.notice(error instanceof Error ? error.message : "Task context could not be loaded.", "error"));
	return el(
		"div",
		{ class: "page" },
		el("header", { class: "page-heading" }, el("div", {}, el("p", { class: "kicker" }, "Session workspace"), el("h1", {}, "No session selected"), el("p", { class: "lead" }, "Delegate a task, or attach an existing native session without starting new work."))),
		el("div", { class: "settings-grid" }, el("div", { class: "empty-state empty-state--large" }, el("h2", {}, "Start from the task"), el("p", {}, "The normal path previews profile, environment, and effects before delegation."), el("a", { class: "button button--primary", href: "#/backlog" }, "Open backlog")), form),
	);
}
